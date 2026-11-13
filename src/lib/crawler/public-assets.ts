import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HttpResult } from "./http";
import { extOf } from "./url";

type Fetched = HttpResult & { attempts: number };

interface Entry {
  meta: Omit<Fetched, "body">;
  file: string;
}

/**
 * Anonymous asset cache shared by the profiles of one combined-discovery crawl.
 *
 * Every asset URL is requested *without any credentials* at most once. If that anonymous request
 * succeeds the asset is public: its bytes are kept on disk and handed to every profile that needs
 * it, so nothing public is downloaded twice. If the anonymous request is refused (401/403, a bounce
 * to the login page, an HTML page in place of the file, any error) the cache answers "not public" and
 * each profile fetches the asset itself with its own session — those bytes never enter this cache,
 * so one account's protected files cannot reach another account's view.
 */
export class PublicAssetCache {
  private entries = new Map<string, Promise<Entry | null>>();
  readonly stats = { anonymousRequests: 0, publicAssets: 0, protectedAssets: 0, reused: 0 };

  constructor(private dir: string) {}

  async get(url: string, maxBytes: number, fetchAnonymous: () => Promise<Fetched>, loginUrl?: string): Promise<Fetched | null> {
    let pending = this.entries.get(url);
    const first = !pending;
    if (!pending) {
      pending = this.load(url, fetchAnonymous, loginUrl);
      this.entries.set(url, pending);
    }
    const entry = await pending;
    if (!entry) return null;
    if (!first) this.stats.reused++;
    const body = await fs.promises.readFile(entry.file);
    if (body.length > maxBytes) return null;
    return { ...entry.meta, body };
  }

  private async load(url: string, fetchAnonymous: () => Promise<Fetched>, loginUrl?: string): Promise<Entry | null> {
    this.stats.anonymousRequests++;
    let res: Fetched;
    try {
      res = await fetchAnonymous();
    } catch {
      this.stats.protectedAssets++;
      return null;
    }
    if (!isPublicResponse(url, res, loginUrl)) {
      this.stats.protectedAssets++;
      return null;
    }
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, crypto.createHash("sha256").update(url).digest("hex"));
    await fs.promises.writeFile(file, res.body, { mode: 0o600 });
    this.stats.publicAssets++;
    const { body: _body, ...meta } = res;
    return { meta, file };
  }

  async dispose() {
    this.entries.clear();
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }
}

/** An anonymous response only counts as the real, public asset when it is a 2xx that is not a login/HTML stand-in. */
export function isPublicResponse(requested: string, res: HttpResult, loginUrl?: string): boolean {
  if (res.status < 200 || res.status >= 300) return false;
  try {
    const final = new URL(res.url);
    if (loginUrl) {
      const login = new URL(loginUrl);
      if (final.origin === login.origin && final.pathname === login.pathname) return false;
    }
    const ext = extOf(new URL(requested).pathname);
    const ct = res.contentType.split(";")[0].trim();
    if (ct === "text/html" && ext && !["html", "htm", "php", "asp", "aspx"].includes(ext)) return false;
  } catch {
    return false;
  }
  return true;
}
