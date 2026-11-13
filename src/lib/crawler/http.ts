import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import type { IncomingMessage } from "node:http";
import { checkUrlSyntax, createGuardedLookup, SsrfError } from "./security";

export const USER_AGENT = "UniversalCloneBot/3.1 (+authorized-offline-archiver)";

export type HttpErrorKind =
  | "timeout"
  | "network"
  | "ssl"
  | "too_large"
  | "redirect_loop"
  | "blocked"
  | "aborted"
  | "invalid_url";

export class HttpError extends Error {
  kind: HttpErrorKind;
  retryable: boolean;
  constructor(kind: HttpErrorKind, message: string) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    this.retryable = kind === "timeout" || kind === "network";
  }
}

export interface HttpResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  redirects: string[];
  contentType: string;
}

export interface HttpOptions {
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  maxRedirects?: number;
  /** Called for every redirect target; throw to refuse the redirect. */
  validateRedirect?: (url: URL) => void | Promise<void>;
  /** Called with the response headers before any body is read; throw to refuse. */
  onHeaders?: (status: number, headers: http.IncomingHttpHeaders, url: URL) => void;
  /**
   * Extra request headers computed separately for every hop (initial URL and each redirect target).
   * Used to attach an authenticated profile's cookies: the callback decides per URL, so session
   * cookies are never forwarded to a redirect target they do not belong to.
   */
  headersFor?: (url: URL) => Promise<Record<string, string>> | Record<string, string>;
}

const SSL_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_NOT_YET_VALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

function classify(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof SsrfError) return new HttpError("blocked", err.message);
  const e = err as NodeJS.ErrnoException;
  if (e && e.cause instanceof SsrfError) return new HttpError("blocked", e.cause.message);
  if (e && e.code && SSL_CODES.has(e.code)) return new HttpError("ssl", `SSL error: ${e.code}`);
  if (e && /certificate|ssl|tls/i.test(e.message || "") && e.code !== "ECONNRESET") return new HttpError("ssl", `SSL error: ${e.message}`);
  return new HttpError("network", `${e?.code ? e.code + ": " : ""}${e?.message ?? String(err)}`);
}

function request(url: URL, o: Required<Pick<HttpOptions, "timeoutMs" | "maxBytes">> & HttpOptions): Promise<{ res: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      o.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const req = lib.request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: createGuardedLookup(!!o.allowPrivate) as never,
        headers: {
          "user-agent": USER_AGENT,
          accept: "*/*",
          "accept-encoding": "gzip, deflate, br",
          ...o.headers,
        },
      },
      (res) => {
        try {
          o.onHeaders?.(res.statusCode ?? 0, res.headers, url);
        } catch (e) {
          res.destroy();
          return done(() => reject(e));
        }
        const status = res.statusCode ?? 0;
        // Redirect bodies are never needed.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return done(() => resolve({ res, body: Buffer.alloc(0) }));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > o.maxBytes && !res.headers["content-encoding"]) {
          done(() => reject(new HttpError("too_large", `File is ${declared} bytes, limit is ${o.maxBytes}`)));
          res.destroy();
          return;
        }
        let stream: NodeJS.ReadableStream = res;
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) {
            done(() => reject(new HttpError("too_large", `File exceeds the ${o.maxBytes} byte limit`)));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => done(() => resolve({ res, body: Buffer.concat(chunks) })));
        stream.on("error", (e) => done(() => reject(classify(e))));
        res.on("error", (e) => done(() => reject(classify(e))));
        res.on("aborted", () => done(() => reject(new HttpError("network", "Connection aborted by server"))));
      },
    );
    const onAbort = () => {
      req.destroy();
      done(() => reject(new HttpError("aborted", "Request aborted")));
    };
    if (o.signal) {
      if (o.signal.aborted) return onAbort();
      o.signal.addEventListener("abort", onAbort, { once: true });
    }
    const total = setTimeout(() => {
      req.destroy();
      done(() => reject(new HttpError("timeout", `Timed out after ${o.timeoutMs * 3}ms`)));
    }, o.timeoutMs * 3);
    req.setTimeout(o.timeoutMs, () => {
      req.destroy();
      done(() => reject(new HttpError("timeout", `No response for ${o.timeoutMs}ms`)));
    });
    req.on("error", (e) => done(() => reject(classify(e))));
    req.end();
  });
}

/**
 * GET with manual redirect handling. Every hop is checked for SSRF and passed to
 * `validateRedirect`, so a public URL can never bounce the crawler into a private
 * network or out of the authorised scope.
 */
export async function httpGet(rawUrl: string, opts: HttpOptions = {}): Promise<HttpResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError("invalid_url", `Invalid URL: ${rawUrl}`);
  }
  const maxRedirects = opts.maxRedirects ?? 8;
  const seen = new Set<string>();
  const redirects: string[] = [];
  const o = { ...opts, timeoutMs: opts.timeoutMs ?? 20000, maxBytes: opts.maxBytes ?? 25 * 1024 * 1024 };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    try {
      checkUrlSyntax(url, !!opts.allowPrivate);
    } catch (e) {
      throw classify(e);
    }
    if (seen.has(url.href)) throw new HttpError("redirect_loop", `Redirect loop at ${url.href}`);
    seen.add(url.href);
    let out: { res: IncomingMessage; body: Buffer };
    try {
      const hopHeaders = opts.headersFor ? await opts.headersFor(url) : undefined;
      out = await request(url, hopHeaders ? { ...o, headers: { ...o.headers, ...hopHeaders } } : o);
    } catch (e) {
      throw classify(e);
    }
    const status = out.res.statusCode ?? 0;
    const loc = out.res.headers.location;
    if (status >= 300 && status < 400 && loc) {
      let next: URL;
      try {
        next = new URL(loc, url);
      } catch {
        throw new HttpError("invalid_url", `Bad redirect target: ${loc}`);
      }
      try {
        checkUrlSyntax(next, !!opts.allowPrivate);
        await opts.validateRedirect?.(next);
      } catch (e) {
        throw new HttpError("blocked", `Redirect to ${next.href} refused: ${(e as Error).message}`);
      }
      redirects.push(next.href);
      url = next;
      continue;
    }
    return {
      url: url.href,
      status,
      headers: out.res.headers,
      body: out.body,
      redirects,
      contentType: String(out.res.headers["content-type"] || "").toLowerCase(),
    };
  }
  throw new HttpError("redirect_loop", `Too many redirects (>${maxRedirects})`);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface RetryOptions extends HttpOptions {
  retries: number;
  retryBaseMs: number;
  onRetry?: (attempt: number, reason: string, waitMs: number) => void;
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** GET with exponential backoff. Honors Retry-After for 429/503. 404/403 are never retried. */
export async function fetchWithRetry(url: string, o: RetryOptions): Promise<HttpResult & { attempts: number }> {
  let attempt = 0;
  for (;;) {
    let reason = "";
    let retryAfterMs = 0;
    try {
      const r = await httpGet(url, o);
      if (!RETRY_STATUS.has(r.status) || attempt >= o.retries) return { ...r, attempts: attempt + 1 };
      reason = `HTTP ${r.status}`;
      const ra = r.headers["retry-after"];
      if (ra) {
        const secs = Number(ra);
        if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
        else {
          const d = Date.parse(String(ra));
          if (!Number.isNaN(d)) retryAfterMs = Math.max(0, d - Date.now());
        }
      }
    } catch (e) {
      const err = e as HttpError;
      if (!(err instanceof HttpError) || !err.retryable || attempt >= o.retries || o.signal?.aborted) {
        (err as HttpError & { attempts?: number }).attempts = attempt + 1;
        throw err;
      }
      reason = err.message;
    }
    const backoff = o.retryBaseMs * 2 ** attempt + Math.floor(Math.random() * (o.retryBaseMs / 2 + 1));
    const wait = Math.min(30000, Math.max(backoff, retryAfterMs));
    attempt++;
    o.onRetry?.(attempt, reason, wait);
    await sleep(wait, o.signal);
    if (o.signal?.aborted) throw new HttpError("aborted", "Request aborted");
  }
}

/** Ensures only one request per host starts within `delayMs`. */
export class HostThrottle {
  private next = new Map<string, number>();
  async wait(host: string, delayMs: number, signal?: AbortSignal): Promise<void> {
    if (delayMs <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + delayMs);
    if (at > now) await sleep(at - now, signal);
  }
}
