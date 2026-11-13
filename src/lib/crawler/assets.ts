import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decodeHtml, extractCssRefs, extractJsAssetUrls } from "./parser";
import { checkUrlSyntax, safeJoin } from "./security";
import { HttpError, type HttpResult } from "./http";
import { assetLocalPath, extOf, PathRegistry, Scope, urlKey } from "./url";
import type { FailureRecord, LogTag } from "./types";

export interface AssetRecord {
  url: string;
  key: string;
  localPath: string;
  status: "ok" | "failed" | "skipped" | "duplicate";
  size: number;
  contentType: string;
  sha256?: string;
  error?: string;
  httpStatus?: number;
  referrers: string[];
  duplicateOf?: string;
  isCss?: boolean;
  external: boolean;
  /** Authenticated crawls: whether the file was fetched with the profile's session or anonymously (shared, public). */
  fetchedWith?: "session" | "anonymous";
}

export interface AssetDeps {
  siteDir: string;
  registry: PathRegistry;
  scope: Scope;
  primaryHost: () => string;
  primaryPort: () => string;
  allowPrivate: boolean;
  externalAssets: boolean;
  maxFileSize: number;
  /** Normalises an asset URL (keeps query strings, strips tracking). */
  normalize: (raw: string) => string | null;
  fetch: (url: string, maxBytes: number) => Promise<HttpResult & { attempts: number; fetchedWith?: "session" | "anonymous" }>;
  remainingBytes: () => number;
  addBytes: (n: number) => void;
  log: (tag: LogTag, msg: string) => void;
  onDiscovered: () => void;
  onDownloaded: () => void;
  onFailed: () => void;
  onDuplicate: () => void;
  onFailure: (f: FailureRecord) => void;
  isCancelled: () => boolean;
}

const MAX_NESTING = 4;

export class AssetManager {
  records = new Map<string, AssetRecord>();
  private inflight = new Map<string, Promise<AssetRecord | null>>();
  private hashes = new Map<string, string>();
  constructor(private d: AssetDeps) {}

  /** Rebuilds derived indexes after loading saved state. */
  restore(records: AssetRecord[]) {
    for (const r of records) {
      this.records.set(r.key, r);
      if (r.status === "ok" && r.sha256 && !r.isCss) this.hashes.set(r.sha256, r.key);
      if (r.localPath) this.d.registry.reserve(r.localPath, r.status === "duplicate" ? (r.duplicateOf ?? r.key) : r.key);
    }
  }

  get(key: string): AssetRecord | undefined {
    return this.records.get(key);
  }

  cssFiles(): AssetRecord[] {
    return [...this.records.values()].filter((r) => r.isCss && r.status === "ok");
  }

  async download(raw: string, referrer: string, depth = 0): Promise<AssetRecord | null> {
    if (this.d.isCancelled()) return null;
    const norm = this.d.normalize(raw);
    if (!norm) return null;
    const key = urlKey(norm);
    const existing = this.records.get(key);
    if (existing) {
      if (!existing.referrers.includes(referrer) && existing.referrers.length < 20) existing.referrers.push(referrer);
      return existing;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(norm, key, referrer, depth).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private newRecord(url: string, key: string, referrer: string): AssetRecord {
    let external = true;
    try {
      external = !this.d.scope.isSameSite(new URL(url));
    } catch {
      /* keep */
    }
    return { url, key, localPath: "", status: "skipped", size: 0, contentType: "", referrers: [referrer], external };
  }

  private async run(url: string, key: string, referrer: string, depth: number): Promise<AssetRecord | null> {
    const rec = this.newRecord(url, key, referrer);
    this.records.set(key, rec);
    this.d.onDiscovered();
    if (rec.external && !this.d.externalAssets) {
      rec.error = "external assets disabled";
      return rec;
    }
    try {
      checkUrlSyntax(new URL(url), this.d.allowPrivate);
    } catch (e) {
      return this.fail(rec, (e as Error).message, undefined, "skipped");
    }
    const remaining = this.d.remainingBytes();
    if (remaining <= 0) {
      rec.error = "total size quota reached";
      return rec;
    }
    let res: HttpResult & { attempts: number; fetchedWith?: "session" | "anonymous" };
    try {
      res = await this.d.fetch(url, Math.min(this.d.maxFileSize, remaining));
      if (res.fetchedWith) rec.fetchedWith = res.fetchedWith;
    } catch (e) {
      const err = e as HttpError;
      if (this.d.isCancelled()) {
        this.records.delete(key);
        return null;
      }
      const kind = err instanceof HttpError && (err.kind === "too_large" || err.kind === "blocked") ? "skipped" : "failed";
      return this.fail(rec, err.message, undefined, kind, (err as { attempts?: number }).attempts);
    }
    return this.store(rec, res, referrer, depth);
  }

  /** Stores an already-fetched response as an asset (used for non-HTML responses found while crawling pages). */
  async ingest(url: string, res: HttpResult, referrer: string): Promise<AssetRecord | null> {
    const norm = this.d.normalize(url);
    if (!norm) return null;
    const key = urlKey(norm);
    if (this.records.has(key)) return this.records.get(key)!;
    const rec = this.newRecord(norm, key, referrer);
    this.records.set(key, rec);
    this.d.onDiscovered();
    return this.store(rec, res, referrer, 0);
  }

  private fail(rec: AssetRecord, error: string, httpStatus: number | undefined, status: "failed" | "skipped", attempts?: number): AssetRecord {
    rec.status = status;
    rec.error = error;
    rec.httpStatus = httpStatus;
    this.d.onFailed();
    this.d.onFailure({ url: rec.url, kind: "asset", status: httpStatus, error, referrer: rec.referrers[0], attempts });
    this.d.log(status === "failed" ? "FAILED" : "SKIP", `${rec.url} — ${error}`);
    return rec;
  }

  private async store(rec: AssetRecord, res: HttpResult, referrer: string, depth: number): Promise<AssetRecord> {
    if (res.status < 200 || res.status >= 300) return this.fail(rec, `HTTP ${res.status}`, res.status, "failed");
    const ct = res.contentType.split(";")[0].trim();
    const ext = extOf(new URL(rec.url).pathname);
    // Soft-404: a server answering a .png/.css/.woff request with an HTML page.
    if (ct === "text/html" && ext && !["html", "htm", "php", "asp", "aspx"].includes(ext)) {
      return this.fail(rec, "server returned an HTML page instead of the file", res.status, "failed");
    }
    if (res.body.length > this.d.remainingBytes()) {
      rec.error = "total size quota reached";
      rec.status = "skipped";
      return rec;
    }
    const sha = crypto.createHash("sha256").update(res.body).digest("hex");
    const isCss = ct === "text/css" || ext === "css";
    rec.size = res.body.length;
    rec.contentType = ct;
    rec.sha256 = sha;
    rec.httpStatus = res.status;
    rec.isCss = isCss;
    const canonicalKey = this.hashes.get(sha);
    if (canonicalKey && !isCss) {
      const canon = this.records.get(canonicalKey)!;
      rec.status = "duplicate";
      rec.duplicateOf = canonicalKey;
      rec.localPath = canon.localPath;
      this.d.onDuplicate();
      this.d.log("DUP", `${rec.url} is identical to ${canon.url}`);
      return rec;
    }
    // Claim the hash and the output path synchronously (before any await) so that two
    // identical files downloading concurrently are detected as duplicates.
    const desired = assetLocalPath(new URL(rec.url), this.d.primaryHost(), this.d.primaryPort(), ct);
    rec.localPath = this.d.registry.reserve(desired, rec.key);
    if (!isCss) this.hashes.set(sha, rec.key);
    const full = safeJoin(this.d.siteDir, rec.localPath);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, res.body);
    rec.status = "ok";
    this.d.addBytes(res.body.length);
    this.d.onDownloaded();
    this.d.log("ASSET", `${rec.url} (${res.body.length} B)`);

    if (depth < MAX_NESTING) {
      let children: string[] = [];
      if (isCss) {
        children = extractCssRefs(decodeHtml(res.body, ct), res.url);
      } else if ((ct.includes("javascript") || ext === "js" || ext === "mjs") && res.body.length < 2 * 1024 * 1024) {
        children = extractJsAssetUrls(res.body.toString("utf8"), res.url, 60);
      }
      if (children.length) {
        const queue = [...children];
        const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
            await this.download(c, rec.url, depth + 1);
          }
        });
        await Promise.all(workers);
      }
    }
    return rec;
  }
}
