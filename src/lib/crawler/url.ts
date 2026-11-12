import crypto from "node:crypto";
import path from "node:path";

export interface NormalizeOptions {
  keepQuery: boolean;
  stripParams: Set<string>;
  denyParams: Set<string>;
  allowParams: Set<string>;
}

export function hash6(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 6);
}

/**
 * Canonical form of a URL:
 *  - http/https only, fragment removed, default port removed (URL does this)
 *  - duplicate slashes collapsed, trailing slash removed (except for the root)
 *  - tracking parameters removed, remaining parameters sorted
 * Returns null if the URL is invalid, not http(s), or contains a denied parameter.
 */
export function normalizeUrl(raw: string, base: string | undefined, o: NormalizeOptions): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  u.pathname = u.pathname.replace(/\/{2,}/g, "/");
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  if (!o.keepQuery) {
    u.search = "";
  } else if (u.search) {
    const entries: Array<[string, string]> = [];
    for (const [k, v] of u.searchParams.entries()) {
      const lk = k.toLowerCase();
      if (o.stripParams.has(lk)) continue;
      if (o.denyParams.has(lk)) return null;
      if (o.allowParams.size > 0 && !o.allowParams.has(lk)) continue;
      entries.push([k, v]);
    }
    entries.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    const sp = new URLSearchParams();
    for (const [k, v] of entries) sp.append(k, v);
    u.search = sp.toString();
  }
  return u.href;
}

/** Key used for visited-set comparisons (www and non-www are the same site). */
export function urlKey(normalized: string): string {
  const u = new URL(normalized);
  if (u.hostname.startsWith("www.")) u.hostname = u.hostname.slice(4);
  return u.href;
}

const CALENDAR_PATH = /(^|\/)(calendar|cal|agenda)(\/|$)/i;
const DATE_PATH_END = /\/(19|20)\d{2}[-/](0?[1-9]|1[0-2])([-/](0?[1-9]|[12]\d|3[01]))?\/?$/;
const DATE_PARAMS = new Set(["date", "month", "year", "day", "start", "end", "startdate", "enddate", "cal_month", "ym", "cal_year"]);
const DATE_VALUE = /^\d{4}(-\d{1,2}(-\d{1,2})?)?$/;

/** Detects URL patterns that generate unbounded page sets. Returns the reason or null. */
export function detectTrap(u: URL): string | null {
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length > 15) return "path too deep";
  const counts = new Map<string, number>();
  for (const s of segs) {
    const c = (counts.get(s) ?? 0) + 1;
    if (c >= 3 && s.length > 0) return "repeating path segment (loop)";
    counts.set(s, c);
  }
  if (CALENDAR_PATH.test(u.pathname) && DATE_PATH_END.test(u.pathname)) return "calendar trap";
  for (const [k, v] of u.searchParams.entries()) {
    if (DATE_PARAMS.has(k.toLowerCase()) && DATE_VALUE.test(v) && (CALENDAR_PATH.test(u.pathname) || /calendar|events|archive/i.test(u.pathname))) {
      return "calendar trap";
    }
  }
  if (u.href.length > 2000) return "URL too long";
  return null;
}

export const STATIC_EXT = new Set([
  "css", "js", "mjs", "map", "json", "xml", "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "tif", "tiff",
  "woff", "woff2", "ttf", "otf", "eot", "mp4", "webm", "ogv", "mov", "m4v", "mp3", "ogg", "wav", "m4a", "pdf", "doc", "docx",
  "xls", "xlsx", "ppt", "pptx", "zip", "gz", "tar", "rar", "7z", "csv", "txt", "rtf", "epub", "webmanifest", "cur", "bin", "exe", "dmg", "iso", "apk", "msi", "jar", "deb", "rpm", "wasm",
]);

export function extOf(pathname: string): string {
  const last = pathname.split("/").pop() ?? "";
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(last);
  return m ? m[1].toLowerCase() : "";
}

/** Links that point at a file rather than a navigable HTML page. */
export function isStaticFileUrl(u: URL): boolean {
  return STATIC_EXT.has(extOf(u.pathname));
}

const MIME_EXT: Record<string, string> = {
  "text/html": "html",
  "text/css": "css",
  "text/javascript": "js",
  "application/javascript": "js",
  "application/x-javascript": "js",
  "application/json": "json",
  "application/manifest+json": "webmanifest",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "application/font-woff": "woff",
  "application/font-woff2": "woff2",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

export function extFromMime(ct: string): string {
  return MIME_EXT[ct.split(";")[0].trim().toLowerCase()] ?? "";
}

const SEG_BAD = /[^\p{L}\p{N}._~@+-]/gu;

export function sanitizeSegment(seg: string): string {
  let s = seg;
  try {
    s = decodeURIComponent(seg);
  } catch {
    /* keep raw */
  }
  s = s.normalize("NFC").replace(SEG_BAD, "_");
  if (s === "" || s === "." || s === "..") return "_";
  if (s.startsWith(".")) s = "_" + s.slice(1);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = "_" + s;
  if (s.length > 100) {
    const ext = path.extname(s).slice(0, 10);
    s = s.slice(0, 80) + "-" + hash6(s) + ext;
  }
  return s;
}

function querySuffix(search: string): string {
  if (!search) return "";
  const raw = search.replace(/^\?/, "");
  const step1 = raw.replace(/=/g, "-").replace(/&/g, "_");
  let cleaned = step1.replace(/[^A-Za-z0-9._~-]+/g, "-").replace(/^-+|-+$/g, "");
  const altered = cleaned !== step1 || cleaned.length > 40;
  cleaned = cleaned.slice(0, 40);
  return "__" + cleaned + (altered ? "-" + hash6(raw) : "");
}

export function hostPrefix(u: URL, primaryHost: string): string {
  const h = u.hostname.replace(/^www\./, "");
  const portPart = u.port ? `_${u.port}` : "";
  if (h === primaryHost && !u.port) return "";
  return `_sub/${sanitizeSegment(h + portPart)}/`;
}

/** Deterministic local file path (POSIX, relative to the site root) for an HTML page. */
export function pageLocalPath(u: URL, primaryHost: string, primaryPort = ""): string {
  const prefix = u.hostname.replace(/^www\./, "") === primaryHost && u.port === primaryPort ? "" : hostPrefix(u, primaryHost);
  const segs = u.pathname.split("/").filter(Boolean).map(sanitizeSegment);
  const qs = querySuffix(u.search);
  let rel: string;
  if (segs.length === 0) {
    rel = `index${qs}.html`;
  } else {
    const last = segs[segs.length - 1];
    const ext = extOf(last);
    if (ext === "html" || ext === "htm") {
      const stem = last.slice(0, -(ext.length + 1));
      rel = [...segs.slice(0, -1), `${stem}${qs}.${ext}`].join("/");
    } else if (ext) {
      rel = [...segs.slice(0, -1), `${last}${qs}.html`].join("/");
    } else {
      rel = [...segs, `index${qs}.html`].join("/");
    }
  }
  return prefix + rel;
}

/** Deterministic local path for a non-HTML asset. */
export function assetLocalPath(u: URL, primaryHost: string, primaryPort: string, contentType = ""): string {
  const same = u.hostname.replace(/^www\./, "") === primaryHost && u.port === primaryPort;
  const prefix = same ? "" : `_ext/${sanitizeSegment(u.hostname + (u.port ? "_" + u.port : ""))}/`;
  const segs = u.pathname.split("/").filter(Boolean).map(sanitizeSegment);
  if (u.pathname.endsWith("/") || segs.length === 0) segs.push("index");
  let last = segs[segs.length - 1];
  let ext = extOf(last);
  const mimeExt = extFromMime(contentType);
  if (!ext && mimeExt) {
    last += "." + mimeExt;
    ext = mimeExt;
  }
  if (u.search) {
    const h = hash6(u.search);
    last = ext ? last.slice(0, -(ext.length + 1)) + `__${h}.${ext}` : `${last}__${h}`;
  }
  segs[segs.length - 1] = last;
  return prefix + segs.join("/");
}

export function relativeLink(fromFile: string, toFile: string): string {
  const rel = path.posix.relative(path.posix.dirname(fromFile), toFile);
  return rel === "" ? path.posix.basename(toFile) : rel;
}

/** Tracks used output paths so two URLs never overwrite each other (case-insensitive safe). */
export class PathRegistry {
  private used = new Map<string, string>();
  reserve(desired: string, key: string): string {
    let candidate = desired;
    let n = 0;
    for (;;) {
      const lower = candidate.toLowerCase();
      const owner = this.used.get(lower);
      if (owner === undefined || owner === key) {
        this.used.set(lower, key);
        return candidate;
      }
      n++;
      const ext = path.posix.extname(desired);
      const stem = desired.slice(0, desired.length - ext.length);
      candidate = `${stem}-${hash6(key)}${n > 1 ? n : ""}${ext}`;
    }
  }
}

/** Compiles a user pattern: regex if valid, otherwise a glob where * matches anything. */
export function compilePattern(p: string): RegExp {
  const glob = (s: string) => new RegExp("^" + s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
  if (p.length > 200) return glob(p.slice(0, 200));
  if (/^\/.*\/$/.test(p) && p.length > 2) {
    try {
      return new RegExp(p.slice(1, -1), "i");
    } catch {
      /* fall through */
    }
  }
  if (!/[*]/.test(p)) return new RegExp(p.replace(/[.+^${}()|[\]\\?]/g, "\\$&"), "i");
  return glob(p);
}

export interface ScopeOptions {
  includeSubdomains: boolean;
  restrictToPathPrefix: boolean;
  includePatterns: string[];
  excludePatterns: string[];
}

/** Decides which URLs belong to the authorised crawl scope. */
export class Scope {
  baseHost: string;
  basePort: string;
  basePrefix = "/";
  private include: RegExp[];
  private exclude: RegExp[];
  constructor(start: URL, private o: ScopeOptions) {
    this.baseHost = start.hostname.replace(/^www\./, "");
    this.basePort = start.port;
    if (o.restrictToPathPrefix) {
      const i = start.pathname.lastIndexOf("/");
      this.basePrefix = start.pathname.slice(0, i + 1) || "/";
    }
    this.include = o.includePatterns.map(compilePattern);
    this.exclude = o.excludePatterns.map(compilePattern);
  }
  rebase(u: URL) {
    this.baseHost = u.hostname.replace(/^www\./, "");
    this.basePort = u.port;
  }
  isSameSite(u: URL): boolean {
    const h = u.hostname.replace(/^www\./, "");
    if (h === this.baseHost && u.port === this.basePort) return true;
    return this.o.includeSubdomains && h.endsWith("." + this.baseHost);
  }
  /** Checks scope + include/exclude patterns for a page URL. */
  check(u: URL): { ok: true } | { ok: false; reason: string } {
    if (!this.isSameSite(u)) return { ok: false, reason: "outside domain scope" };
    if (this.o.restrictToPathPrefix && !(u.pathname + "/").startsWith(this.basePrefix === "/" ? "/" : this.basePrefix)) {
      return { ok: false, reason: "outside path prefix" };
    }
    const target = u.pathname + u.search;
    if (this.exclude.some((r) => r.test(target) || r.test(u.href))) return { ok: false, reason: "matches exclude pattern" };
    if (this.include.length > 0 && !this.include.some((r) => r.test(target) || r.test(u.href))) {
      return { ok: false, reason: "does not match include pattern" };
    }
    return { ok: true };
  }
}
