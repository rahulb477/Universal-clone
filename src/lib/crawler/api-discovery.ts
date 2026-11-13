import fs from "node:fs";
import path from "node:path";
import { safeJoin } from "./security";
import { extOf, hash6, PathRegistry, sanitizeSegment, STATIC_EXT } from "./url";
import type { ApiDiscoveryMode, LogTag } from "./types";

/**
 * Controlled discovery of fetch/XHR resources.
 *
 * Design rules (enforced here and in the browser request guard in renderer.ts):
 *  - Only requests that the *page itself* issued are observed. The crawler never invents API calls,
 *    never issues introspection queries and never replays a state-changing request.
 *  - The only requests the crawler originates are GET follow-ups of explicit `next` links
 *    (opt-in, bounded, same origin as the observed endpoint).
 *  - Request headers, cookies and `Set-Cookie`/`Authorization` values are never recorded.
 *  - Endpoints that look like payment, credential or session/token endpoints are listed by URL only;
 *    their bodies are never stored. Stored JSON is redacted key- and pattern-wise.
 */

export interface ApiObservation {
  url: string;
  method: string;
  resourceType: "xhr" | "fetch" | "pagination";
  status: number;
  contentType: string;
  /** Size of the response body in bytes when known. */
  bytes?: number;
  /** Response body; only present when the renderer was allowed to keep it (see wantsBody). */
  body?: Buffer;
  linkHeader?: string;
  cacheControl?: string;
  /** The request was refused by the crawl-phase guard (state-changing or unauthorised method). */
  blocked?: boolean;
  blockReason?: string;
  graphql?: GraphqlInfo;
}

export interface GraphqlInfo {
  operationType: "query" | "mutation" | "subscription" | "unknown";
  operationNames: string[];
  /** Names (never values) of the variables sent with the operation. */
  variableNames: string[];
}

export interface ApiRecord {
  /** URL with secret-looking query values replaced. */
  url: string;
  method: string;
  type: "xhr" | "fetch" | "pagination";
  kind: "json" | "graphql" | "other";
  status: number;
  contentType: string;
  bytes: number;
  cacheControl?: string;
  /** Pages that triggered the request (first few). */
  pages: string[];
  /** Profile whose session observed it (combined/authenticated crawls). */
  profile?: string;
  archived: boolean;
  localPath?: string;
  redactedValues?: number;
  /** Why the body was not stored. */
  notArchived?: string;
  blocked?: boolean;
  blockReason?: string;
  graphql?: GraphqlInfo;
  pagination?: { next?: string; followedFrom?: string };
  hits: number;
}

const SECRET_PARAM = /^(access[_-]?token|id[_-]?token|refresh[_-]?token|token|auth|authorization|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|sig|signature|session|sessionid|sid|code|jwt|otp|nonce|state|x-amz-(signature|credential|security-token))$/i;

/** Replaces the values of credential-like query parameters and drops embedded user info. */
export function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.replace(/[?#].*$/, "");
  }
  u.username = "";
  u.password = "";
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) {
    if (SECRET_PARAM.test(k) || looksLikeSecretValue(u.searchParams.get(k) ?? "")) u.searchParams.set(k, "REDACTED");
  }
  return u.href;
}

const SENSITIVE_PATH =
  /(^|[/_.\-])(pay|payment|payments|paymentmethods?|payment[_-]methods?|billing|checkout|cards?|creditcards?|wallet|bank|iban|stripe|paypal|braintree|oauth2?|token|tokens|refresh|login|logout|signin|sign[_-]in|signout|session|sessions|passwords?|passwd|credentials?|secrets?|apikeys?|api[_-]keys?|2fa|mfa|otp|totp|csrf|xsrf|saml|sso|jwks|authorize|authenticate|auth|keys)([/_.\-?]|$)/i;

/** Endpoints whose responses are never stored (payment data, credentials, sessions, tokens). */
export function isSensitiveEndpoint(raw: string): boolean {
  try {
    const u = new URL(raw);
    return SENSITIVE_PATH.test(u.pathname);
  } catch {
    return true;
  }
}

const SECRET_KEY =
  /(pass(word|wd|phrase)?|pwd|secret|token|jwt|bearer|authorization|auth[_-]?(key|code|header)|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|session([_-]?(id|key|token))?|sid|cookie|csrf|xsrf|nonce|otp|totp|mfa|pin|signature|credential|salt|hash)$/i;
const PAYMENT_KEY =
  /(card([_-]?(number|no|num|holder|cvc|cvv|exp\w*))?|cc[_-]?(number|num|no|exp\w*)|pan|cvv2?|cvc2?|security[_-]?code|expir(y|ation)\w*|exp[_-]?(month|year|date)|iban|bic|swift|routing([_-]?number)?|account[_-]?(number|no)|sort[_-]?code|bank\w*|payment[_-]?method\w*|billing\w*|tax[_-]?id|vat[_-]?(id|number))$/i;
const PII_KEY =
  /(e[_-]?mail\w*|phone\w*|mobile\w*|msisdn|ssn|social[_-]?security\w*|national[_-]?id\w*|passport\w*|driver\w*licen[cs]e\w*|date[_-]?of[_-]?birth|birth(day|date)?|dob|address(es|[_-]?line\w*)?|street\w*|postal[_-]?code|post[_-]?code|zip([_-]?code)?|geo|latitude|longitude|lat|lng|ip[_-]?address|ip|gender|first[_-]?name|last[_-]?name|full[_-]?name|surname|given[_-]?name|family[_-]?name)$/i;

const JWT_RE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;
const BEARER_RE = /^(bearer|basic|token)\s+\S{8,}$/i;
const KNOWN_KEY_RE = /^(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}$|^gh[pousr]_[A-Za-z0-9]{20,}$|^xox[abprs]-[A-Za-z0-9-]{10,}$|^AKIA[0-9A-Z]{16}$/;

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function looksLikeCardNumber(s: string): boolean {
  if (!/^[\d \-]{13,23}$/.test(s)) return false;
  const digits = s.replace(/[ \-]/g, "");
  return digits.length >= 13 && digits.length <= 19 && luhn(digits);
}

export function looksLikeSecretValue(s: string): boolean {
  return JWT_RE.test(s) || BEARER_RE.test(s) || KNOWN_KEY_RE.test(s) || looksLikeCardNumber(s);
}

/**
 * Deep-copies JSON while removing credential, payment and personal-data fields.
 * Redaction is conservative: a key that *might* be sensitive loses its value.
 */
export function redactJson(value: unknown): { value: unknown; redacted: number } {
  let redacted = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (depth > 40) {
      redacted++;
      return "[REDACTED:depth]";
    }
    if (Array.isArray(v)) return v.map((x) => visit(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const key = k.replace(/[^A-Za-z0-9_-]/g, "");
        const label = SECRET_KEY.test(key) ? "secret" : PAYMENT_KEY.test(key) ? "payment" : PII_KEY.test(key) ? "personal-data" : null;
        if (label && val !== null && val !== undefined && val !== "" && typeof val !== "boolean") {
          out[k] = `[REDACTED:${label}]`;
          redacted++;
        } else out[k] = visit(val, depth + 1);
      }
      return out;
    }
    if (typeof v === "string") {
      if (looksLikeSecretValue(v.trim())) {
        redacted++;
        return "[REDACTED:secret]";
      }
      if (/^https?:\/\//i.test(v)) {
        const r = redactUrl(v);
        if (r !== v && r.includes("REDACTED")) {
          redacted++;
          return r;
        }
      }
    }
    return v;
  };
  return { value: visit(value, 0), redacted };
}

/**
 * Classifies a GraphQL request body without executing it. Returns "query" only when *every*
 * operation in the document (and in every element of a batch) is a query. Persisted queries
 * (no query text) cannot be verified and are reported as "unknown".
 */
export function classifyGraphql(body: string | null | undefined): GraphqlInfo {
  const unknown: GraphqlInfo = { operationType: "unknown", operationNames: [], variableNames: [] };
  if (!body || body.length > 512 * 1024) return unknown;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return unknown;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0 || items.length > 50) return unknown;
  const names: string[] = [];
  const vars = new Set<string>();
  let worst: GraphqlInfo["operationType"] = "query";
  for (const it of items) {
    if (!it || typeof it !== "object") return unknown;
    const o = it as Record<string, unknown>;
    if (typeof o.query !== "string" || !o.query.trim()) return unknown;
    const doc = classifyGraphqlDocument(o.query);
    if (doc.type === "unknown") return unknown;
    names.push(...doc.names);
    if (typeof o.operationName === "string" && o.operationName && !names.includes(o.operationName)) names.push(o.operationName.slice(0, 80));
    if (o.variables && typeof o.variables === "object") for (const k of Object.keys(o.variables as object).slice(0, 30)) vars.add(k.slice(0, 60));
    if (doc.type === "mutation") worst = "mutation";
    else if (doc.type === "subscription" && worst !== "mutation") worst = "subscription";
  }
  return { operationType: worst, operationNames: [...new Set(names)].slice(0, 20), variableNames: [...vars] };
}

/** Finds the operation types defined at the top level of a GraphQL document. */
export function classifyGraphqlDocument(text: string): { type: "query" | "mutation" | "subscription" | "unknown"; names: string[] } {
  // Remove block strings, strings and comments so braces/keywords inside them are ignored.
  const src = text
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/#[^\n\r]*/g, "");
  let depth = 0;
  let sawOperation = false;
  let type: "query" | "mutation" | "subscription" = "query";
  const names: string[] = [];
  const re = /[{}]|[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  let expectName = false;
  let definitionOpen = false; // a definition keyword was seen and its selection set has not started
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (tok === "{") {
      if (depth === 0 && !definitionOpen) sawOperation = true; // anonymous query shorthand
      depth++;
      definitionOpen = false;
      expectName = false;
      continue;
    }
    if (tok === "}") {
      depth--;
      if (depth < 0) return { type: "unknown", names: [] };
      continue;
    }
    if (depth !== 0) continue;
    if (expectName) {
      expectName = false;
      if (tok !== "on") names.push(tok.slice(0, 80));
      continue;
    }
    if (definitionOpen) continue; // variable definitions / directives before the selection set
    const kw = tok.toLowerCase();
    if (tok === "query" || tok === "mutation" || tok === "subscription") {
      sawOperation = true;
      definitionOpen = true;
      expectName = true;
      if (tok === "mutation") type = "mutation";
      else if (tok === "subscription" && type !== "mutation") type = "subscription";
    } else if (tok === "fragment") {
      definitionOpen = true;
    } else if (kw === "schema" || kw === "type" || kw === "extend" || kw === "directive" || kw === "input" || kw === "enum" || kw === "interface" || kw === "union" || kw === "scalar") {
      return { type: "unknown", names: [] };
    } else {
      // Unexpected top-level token: refuse to guess.
      return { type: "unknown", names: [] };
    }
  }
  if (depth !== 0 || !sawOperation) return { type: "unknown", names: [] };
  return { type, names };
}

const NEXT_KEYS = ["next", "next_url", "nextUrl", "next_page_url", "nextPageUrl", "nextPage", "next_page", "nextLink", "next_link", "@odata.nextLink"];
const CONTAINER_KEYS = ["links", "_links", "paging", "pagination", "meta", "page_info", "pageInfo"];

function asUrlCandidate(v: unknown): string | null {
  if (typeof v === "string" && v.trim() && v.length < 2048 && /^(https?:\/\/|\/|\?|\.{1,2}\/)/i.test(v.trim())) return v.trim();
  if (v && typeof v === "object" && typeof (v as { href?: unknown }).href === "string") return asUrlCandidate((v as { href: string }).href);
  return null;
}

/**
 * Finds the URL of the next page of a paginated JSON endpoint. Only explicit signals are used:
 * an RFC 8288 `Link: <…>; rel="next"` header, a `next`-style URL field, or page counters
 * (`page` < `total_pages`) / `has_more` combined with a numeric `page` query parameter.
 * The result is always on the same origin as `requestUrl`; anything else returns null.
 */
export function detectNextPage(requestUrl: string, json: unknown, linkHeader?: string): string | null {
  let base: URL;
  try {
    base = new URL(requestUrl);
  } catch {
    return null;
  }
  const accept = (candidate: string | null): string | null => {
    if (!candidate) return null;
    try {
      const u = new URL(candidate, base);
      u.hash = "";
      if (u.origin !== base.origin || !/^https?:$/.test(u.protocol) || u.href === base.href) return null;
      return u.href;
    } catch {
      return null;
    }
  };
  if (linkHeader) {
    for (const part of linkHeader.split(/,(?=\s*<)/)) {
      const m = /<([^>]+)>\s*;([\s\S]*)$/.exec(part.trim());
      if (m && /(^|;)\s*rel\s*=\s*"?([^";]*\s)?next(\s[^";]*)?"?/i.test(m[2])) {
        const u = accept(m[1]);
        if (u) return u;
      }
    }
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const containers: Array<Record<string, unknown>> = [o];
  for (const k of CONTAINER_KEYS) if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) containers.push(o[k] as Record<string, unknown>);
  for (const c of containers) {
    for (const k of NEXT_KEYS) {
      const u = accept(asUrlCandidate(c[k]));
      if (u) return u;
    }
  }
  // Page counters. Requires an explicit current page and either a total or a has-more flag.
  const pick = (keys: string[]): unknown => {
    for (const c of containers) for (const k of keys) if (c[k] !== undefined && c[k] !== null) return c[k];
    return undefined;
  };
  const cur = Number(pick(["page", "current_page", "currentPage", "page_number", "pageNumber"]));
  const total = Number(pick(["total_pages", "totalPages", "last_page", "lastPage", "page_count", "pageCount", "pages"]));
  const more = pick(["has_more", "hasMore", "has_next", "hasNext", "has_next_page", "hasNextPage"]);
  if (Number.isInteger(cur) && cur >= 0 && ((Number.isInteger(total) && cur < total) || more === true)) {
    const param = ["page", "p", "pageNumber", "page_number"].find((k) => base.searchParams.has(k)) ?? "page";
    const inUrl = base.searchParams.get(param);
    if (inUrl === null || Number(inUrl) === cur) {
      const u = new URL(base.href);
      u.searchParams.set(param, String(cur + 1));
      return accept(u.href);
    }
  }
  return null;
}

const ASSET_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "woff", "woff2", "ttf", "otf", "mp4", "webm", "mp3", "ogg", "pdf", "css"]);

/** URLs of static assets (images, fonts, media, documents) referenced from a JSON document. */
export function extractAssetUrlsFromJson(json: unknown, base: string, limit = 200): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (out.size >= limit || depth > 30) return;
    if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v as object)) visit(x, depth + 1);
    else if (typeof v === "string" && v.length < 2048 && /^(https?:\/\/|\/)[^\s"'<>]+$/i.test(v)) {
      try {
        const u = new URL(v, base);
        const ext = extOf(u.pathname);
        if (/^https?:$/.test(u.protocol) && ASSET_EXT.has(ext) && STATIC_EXT.has(ext)) out.add(u.href);
      } catch {
        /* not a URL */
      }
    }
  };
  visit(json, 0);
  return [...out];
}

export function isJsonContentType(ct: string): boolean {
  return /(^|[\/+])json\b/i.test(ct.split(";")[0]);
}

/** Local archive path for a stored API response. */
export function apiLocalPath(u: URL, primaryHost: string, primaryPort: string): string {
  const same = u.hostname.replace(/^www\./, "") === primaryHost && u.port === primaryPort;
  const prefix = same ? "_api/" : `_api/_ext/${sanitizeSegment(u.hostname + (u.port ? "_" + u.port : ""))}/`;
  const segs = u.pathname.split("/").filter(Boolean).map(sanitizeSegment);
  if (segs.length === 0) segs.push("index");
  let last = segs[segs.length - 1].replace(/\.json$/i, "");
  if (u.search) last += `__${hash6(u.search)}`;
  segs[segs.length - 1] = `${last}.json`;
  return prefix + segs.join("/");
}

export interface ApiCollectorDeps {
  mode: ApiDiscoveryMode;
  /** Keep eligible bodies in memory (needed for archiving and for reading pagination links). */
  keepBodies: boolean;
  maxResponses: number;
  maxResponseBytes: number;
  siteDir: string;
  registry: PathRegistry;
  primaryHost: () => string;
  primaryPort: () => string;
  /** Whether a URL is inside the authorised crawl scope (bodies are only stored for in-scope endpoints). */
  inScope: (u: URL) => boolean;
  remainingBytes: () => number;
  addBytes: (n: number) => void;
  log: (tag: LogTag, msg: string) => void;
  profile?: string;
}

/**
 * One record per method + URL. GraphQL multiplexes every operation over one URL, so there the
 * operation (and whether it was refused) is part of the identity.
 */
function recordKey(method: string, url: string, graphql?: GraphqlInfo, blocked?: boolean): string {
  const base = `${method} ${url}`;
  if (!graphql) return base;
  return `${base} #${graphql.operationType}:${graphql.operationNames.join(",")}${blocked ? ":blocked" : ""}`;
}

/** Collects, de-duplicates, redacts and (optionally) stores observed API responses for one crawl. */
export class ApiCollector {
  records = new Map<string, ApiRecord>();
  private stored = 0;
  constructor(private d: ApiCollectorDeps) {}

  get enabled() {
    return this.d.mode !== "off";
  }

  /** Decides before the body is read whether it may be kept at all. */
  wantsBody(url: string, method: string, contentType: string, declaredBytes: number | undefined): boolean {
    if (this.d.mode === "off" || !this.d.keepBodies) return false;
    if (method !== "GET" && method !== "POST") return false;
    if (!isJsonContentType(contentType)) return false;
    if (declaredBytes !== undefined && declaredBytes > this.d.maxResponseBytes) return false;
    if (isSensitiveEndpoint(url)) return false;
    try {
      return this.d.inScope(new URL(url));
    } catch {
      return false;
    }
  }

  restore(records: ApiRecord[]) {
    for (const r of records) {
      this.records.set(recordKey(r.method, r.url, r.graphql, r.blocked), r);
      if (r.archived) {
        this.stored++;
        if (r.localPath) this.d.registry.reserve(r.localPath, `api:${r.method} ${r.url}`);
      }
    }
  }

  /**
   * Records one observation. Returns the parsed (unredacted, in-memory only) JSON when the response
   * was eligible, so the caller can look for pagination links and asset URLs without re-reading it.
   */
  async observe(o: ApiObservation, pageUrl: string): Promise<{ record: ApiRecord; json?: unknown; isNew: boolean } | null> {
    if (!this.enabled) return null;
    const url = redactUrl(o.url);
    const method = o.method.toUpperCase();
    const key = recordKey(method, url, o.graphql, o.blocked);
    const existing = this.records.get(key);
    if (existing) {
      existing.hits++;
      if (existing.pages.length < 5 && !existing.pages.includes(pageUrl)) existing.pages.push(pageUrl);
      return { record: existing, isNew: false };
    }
    if (this.records.size >= this.d.maxResponses) return null;
    const kind: ApiRecord["kind"] = o.graphql ? "graphql" : isJsonContentType(o.contentType) ? "json" : "other";
    const rec: ApiRecord = {
      url,
      method,
      type: o.resourceType,
      kind,
      status: o.status,
      contentType: o.contentType.split(";")[0].trim(),
      bytes: o.bytes ?? o.body?.length ?? 0,
      cacheControl: o.cacheControl,
      pages: [pageUrl],
      profile: this.d.profile,
      archived: false,
      hits: 1,
    };
    if (o.graphql) rec.graphql = o.graphql;
    if (o.blocked) {
      rec.blocked = true;
      rec.blockReason = o.blockReason ?? "state-changing request refused";
      rec.notArchived = "request was blocked and never sent";
    }
    this.records.set(key, rec);
    this.d.log("API", `${method} ${url} — ${o.blocked ? `blocked (${rec.blockReason})` : `HTTP ${o.status}${rec.contentType ? `, ${rec.contentType}` : ""}`}`);
    if (o.blocked) return { record: rec, isNew: true };

    let json: unknown;
    let inScope = false;
    try {
      inScope = this.d.inScope(new URL(o.url));
    } catch {
      /* keep false */
    }
    const sensitive = isSensitiveEndpoint(o.url);
    if (o.body && kind !== "other" && o.status >= 200 && o.status < 300 && inScope && !sensitive) {
      try {
        json = JSON.parse(o.body.toString("utf8"));
      } catch {
        json = undefined;
      }
    }
    if (this.d.mode !== "archive") rec.notArchived = "metadata-only mode";
    else if (sensitive) rec.notArchived = "sensitive endpoint (payment, credential or session data) — body never stored";
    else if (!inScope) rec.notArchived = "outside the authorised crawl scope";
    else if (kind === "other") rec.notArchived = "not a JSON response";
    else if (o.status < 200 || o.status >= 300) rec.notArchived = `HTTP ${o.status}`;
    else if (!o.body) rec.notArchived = "body unavailable or larger than the configured limit";
    else if (json === undefined) rec.notArchived = "response was not valid JSON";
    else {
      const red = redactJson(json);
      const text = JSON.stringify(red.value, null, 2);
      const size = Buffer.byteLength(text);
      if (size > this.d.maxResponseBytes) rec.notArchived = "body larger than the configured limit";
      else if (size > this.d.remainingBytes()) rec.notArchived = "total size quota reached";
      else {
        const u = new URL(o.url);
        const suffix = method === "GET" ? "" : `__${method.toLowerCase()}-${hash6(key + ":" + this.stored)}`;
        const desired = apiLocalPath(u, this.d.primaryHost(), this.d.primaryPort()).replace(/\.json$/, `${suffix}.json`);
        rec.localPath = this.d.registry.reserve(desired, `api:${key}`);
        const full = safeJoin(this.d.siteDir, rec.localPath);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, text);
        rec.archived = true;
        rec.redactedValues = red.redacted;
        rec.bytes = rec.bytes || size;
        this.stored++;
        this.d.addBytes(size);
      }
    }
    return { record: rec, json, isNew: true };
  }

  list(): ApiRecord[] {
    return [...this.records.values()];
  }
}
