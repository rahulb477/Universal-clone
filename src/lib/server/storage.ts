import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { DATA_DIR } from "./config";

/**
 * Archive / report storage shared by the web tier and the worker.
 *
 *  - "local": files under ARCHIVE_DIR (default CRAWL_DATA_DIR/_store). Only valid when the web
 *    process and the worker see the same disk (single host, or `inline` worker mode).
 *  - "s3": any S3-compatible object store (AWS S3, Cloudflare R2, MinIO, …). Required when the web
 *    tier runs on Vercel, because it has no shared disk with the worker. Downloads are then served
 *    by a short-lived pre-signed URL that is only issued after the ownership check.
 */
export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  size?: number;
}

export interface ArchiveStore {
  readonly kind: "local" | "s3";
  /** Uploads a file. `move` lets the local store rename instead of copying. */
  putFile(key: string, file: string, contentType: string, opts?: { move?: boolean; sha256?: string }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** A time-limited direct download URL, or null when the store has none (local). */
  signedUrl(key: string, ttlSeconds: number, downloadName?: string): string | null;
  remove(keys: string[]): Promise<void>;
  /** Round-trip check used by the health endpoint and at worker start. */
  check(): Promise<void>;
}

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,300}$/;
function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes("..") || key.includes("//")) throw new Error("invalid storage key");
}

export const archiveKey = (jobId: string) => `jobs/${jobId}/site.zip`;
export const reportKey = (jobId: string, file: string) => `jobs/${jobId}/report/${file}`;

// ---------- local ----------

class LocalStore implements ArchiveStore {
  readonly kind = "local" as const;
  constructor(private root: string) {}

  private full(key: string) {
    assertKey(key);
    return path.join(this.root, key);
  }

  async putFile(key: string, file: string, _contentType: string, opts: { move?: boolean } = {}) {
    const dest = this.full(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    if (opts.move) {
      try {
        await fs.promises.rename(file, dest);
        return;
      } catch {
        /* different filesystem: fall through to copy */
      }
    }
    await fs.promises.copyFile(file, dest);
    if (opts.move) await fs.promises.rm(file, { force: true });
  }

  async get(key: string): Promise<StoredObject | null> {
    const file = this.full(key);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) return null;
    return { body: Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream<Uint8Array>, size: stat.size };
  }

  signedUrl() {
    return null;
  }

  async remove(keys: string[]) {
    for (const k of keys) await fs.promises.rm(this.full(k), { force: true });
    // Drop the now-empty job folder(s).
    const dirs = new Set(keys.map((k) => path.dirname(this.full(k))));
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      await fs.promises.rmdir(d).catch(() => {});
      await fs.promises.rmdir(path.dirname(d)).catch(() => {});
    }
  }

  async check() {
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const probe = path.join(this.root, `.probe-${process.pid}`);
    await fs.promises.writeFile(probe, "ok");
    await fs.promises.rm(probe, { force: true });
  }
}

// ---------- S3 (AWS Signature Version 4, no SDK dependency) ----------

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  /** Pause before the first upload retry (doubles for the second). Default 1000 ms. */
  retryDelayMs?: number;
}

/** A failed upload carries the HTTP status (0 for a connection error) so that only transient failures are retried. */
class UploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
const UPLOAD_ATTEMPTS = 3;
const transient = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac("sha256", key).update(data).digest();
const hex = (data: crypto.BinaryLike) => crypto.createHash("sha256").update(data).digest("hex");
/** RFC 3986 encoding as SigV4 requires it. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export class S3Store implements ArchiveStore {
  readonly kind = "s3" as const;
  constructor(private c: S3Config) {}

  private target(key: string): { url: URL; canonicalPath: string } {
    assertKey(key);
    const base = new URL(this.c.endpoint);
    const encodedKey = key.split("/").map(enc).join("/");
    if (this.c.pathStyle) {
      const p = `${base.pathname.replace(/\/$/, "")}/${enc(this.c.bucket)}/${encodedKey}`;
      return { url: new URL(p, base), canonicalPath: p };
    }
    const u = new URL(base.href);
    u.hostname = `${this.c.bucket}.${base.hostname}`;
    const p = `${base.pathname.replace(/\/$/, "")}/${encodedKey}`;
    u.pathname = p;
    return { url: u, canonicalPath: p };
  }

  private signingKey(date: string) {
    return hmac(hmac(hmac(hmac("AWS4" + this.c.secretAccessKey, date), this.c.region), "s3"), "aws4_request");
  }

  /** Header-signed request. */
  private sign(method: string, key: string, payloadHash: string, extra: Record<string, string> = {}): { url: URL; headers: Record<string, string> } {
    const { url, canonicalPath } = this.target(key);
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = now.slice(0, 8);
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": now, ...extra };
    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
    const canonical = [method, canonicalPath, "", names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
    const scope = `${date}/${this.c.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", now, scope, hex(canonical)].join("\n");
    const signature = hmac(this.signingKey(date), toSign).toString("hex");
    lower.authorization = `AWS4-HMAC-SHA256 Credential=${this.c.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    return { url, headers: lower };
  }

  /**
   * One PUT per object. A whole crawl depends on this request, so connection errors and 5xx / 429 / 408 answers are
   * retried (3 attempts in total, PUT is idempotent). Other 4xx answers — wrong credentials, missing bucket — are not.
   */
  async putFile(key: string, file: string, contentType: string, opts: { move?: boolean; sha256?: string } = {}) {
    const stat = await fs.promises.stat(file);
    const payloadHash = opts.sha256 ?? (await sha256File(file));
    for (let attempt = 1; ; attempt++) {
      try {
        await this.putOnce(key, file, contentType, stat.size, payloadHash);
        break;
      } catch (e) {
        // Anything that is not a failed request (an invalid key, an unreadable file) is not going to change.
        if (!(e instanceof UploadError) || attempt >= UPLOAD_ATTEMPTS || !transient(e.status)) throw e;
        await new Promise((r) => setTimeout(r, (this.c.retryDelayMs ?? 1000) * 2 ** (attempt - 1)));
      }
    }
    if (opts.move) await fs.promises.rm(file, { force: true });
  }

  private putOnce(key: string, file: string, contentType: string, size: number, payloadHash: string): Promise<void> {
    // Signed per attempt: the signature includes the current time.
    const { url, headers } = this.sign("PUT", key, payloadHash, { "content-type": contentType, "content-length": String(size) });
    return new Promise<void>((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const source = fs.createReadStream(file);
      const fail = (e: Error) => {
        source.destroy();
        reject(e instanceof UploadError ? e : new UploadError(`object storage upload failed: ${e.message}`, 0));
      };
      const req = lib.request(url, { method: "PUT", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.length < 20 && chunks.push(c));
        res.on("error", fail);
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
          else fail(new UploadError(`object storage upload failed: HTTP ${res.statusCode} ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`, res.statusCode ?? 0));
        });
      });
      req.on("error", fail);
      source.on("error", fail).pipe(req);
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const { url, headers } = this.sign("GET", key, hex(""));
    delete headers.host;
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok || !res.body) throw new Error(`object storage read failed: HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length"));
    return { body: res.body as ReadableStream<Uint8Array>, size: Number.isFinite(len) && len > 0 ? len : undefined };
  }

  /** Query-string (pre-signed) GET. The URL is the only credential, so keep ttl short. */
  signedUrl(key: string, ttlSeconds: number, downloadName?: string): string {
    const { url, canonicalPath } = this.target(key);
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = now.slice(0, 8);
    const scope = `${date}/${this.c.region}/s3/aws4_request`;
    const q: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.c.accessKeyId}/${scope}`,
      "X-Amz-Date": now,
      "X-Amz-Expires": String(Math.min(3600, Math.max(1, Math.floor(ttlSeconds)))),
      "X-Amz-SignedHeaders": "host",
    };
    if (downloadName) q["response-content-disposition"] = `attachment; filename="${downloadName.replace(/[^a-zA-Z0-9._-]/g, "_")}"`;
    const query = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join("&");
    const canonical = ["GET", canonicalPath, query, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", now, scope, hex(canonical)].join("\n");
    const signature = hmac(this.signingKey(date), toSign).toString("hex");
    return `${url.origin}${canonicalPath}?${query}&X-Amz-Signature=${signature}`;
  }

  async remove(keys: string[]) {
    for (const key of keys) {
      const { url, headers } = this.sign("DELETE", key, hex(""));
      delete headers.host;
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok && res.status !== 404) throw new Error(`object storage delete failed: HTTP ${res.status}`);
    }
  }

  async check() {
    const key = `health/probe-${crypto.randomBytes(6).toString("hex")}.txt`;
    const tmp = path.join(DATA_DIR, `.s3-probe-${process.pid}-${Date.now()}`);
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(tmp, "ok");
    try {
      await this.putFile(key, tmp, "text/plain");
      const got = await this.get(key);
      const text = got ? await new Response(got.body).text() : "";
      if (text !== "ok") throw new Error("object storage round-trip returned unexpected content");
      await this.remove([key]);
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")));
  });
}

export function storageKind(): "local" | "s3" {
  const v = process.env.ARCHIVE_STORAGE;
  if (v === "s3" || v === "local") return v;
  return process.env.S3_BUCKET ? "s3" : "local";
}

let cached: ArchiveStore | null = null;

export function getStore(): ArchiveStore {
  if (cached) return cached;
  if (storageKind() === "s3") {
    const need = (n: string) => {
      const v = process.env[n];
      if (!v) throw new Error(`ARCHIVE_STORAGE=s3 requires ${n}`);
      return v;
    };
    const region = process.env.S3_REGION || "us-east-1";
    const endpoint = process.env.S3_ENDPOINT || `https://s3.${region}.amazonaws.com`;
    cached = new S3Store({
      endpoint,
      region,
      bucket: need("S3_BUCKET"),
      accessKeyId: need("S3_ACCESS_KEY_ID"),
      secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
      pathStyle: process.env.S3_FORCE_PATH_STYLE ? process.env.S3_FORCE_PATH_STYLE === "1" : !!process.env.S3_ENDPOINT,
    });
  } else {
    cached = new LocalStore(process.env.ARCHIVE_DIR || path.join(DATA_DIR, "_store"));
  }
  return cached;
}

/** Test hook. */
export function resetStore() {
  cached = null;
}
