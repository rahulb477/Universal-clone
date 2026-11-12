import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AssetManager, type AssetRecord } from "./assets";
import { decodeHtml, extractFromHtml, rewriteCss, rewriteHtml } from "./parser";
import { fetchWithRetry, HostThrottle, HttpError, sleep, type HttpResult } from "./http";
import { Renderer } from "./renderer";
import { Robots, parseSitemap } from "./robots";
import { writeReports, type DiscoveredRow, type PageRow, type ReportData } from "./report";
import { assertPublicUrl, safeJoin, SsrfError } from "./security";
import { sanitizeOptions, type CrawlOptions, type CrawlResult, type CrawlStats, type CrawlStatus, type FailureRecord, type LogEvent, type LogTag } from "./types";
import { detectTrap, isStaticFileUrl, normalizeUrl, pageLocalPath, PathRegistry, relativeLink, Scope, urlKey, type NormalizeOptions } from "./url";
import { runVisualComparison, type VisualRow } from "./visual";
import { createZip } from "./zip";

export interface CrawlerInternal {
  workDir: string;
  /** Operator-only switch (never reachable from the API): allows crawling private addresses, for tests/intranet use. */
  allowPrivateNetworks?: boolean;
  resume?: boolean;
}

interface QueueItem {
  url: string;
  key: string;
  depth: number;
  referrer?: string;
}

type DiscStatus = "queued" | "crawling" | "crawled" | "failed" | "skipped" | "duplicate";
interface Discovered {
  url: string;
  status: DiscStatus;
  depth: number;
  referrer?: string;
  reason?: string;
}

interface PageRecord {
  key: string;
  url: string;
  finalUrl: string;
  localPath: string;
  status: "ok";
  httpStatus: number;
  title: string;
  depth: number;
  rawFile: string;
  renderedWith: string;
  bytes: number;
}

class Semaphore {
  private waiting: Array<() => void> = [];
  constructor(private n: number) {}
  async acquire() {
    if (this.n > 0) {
      this.n--;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.n++;
  }
}

const MISSING_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not archived</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:15vh auto;padding:0 1rem;color:#0f172a}code{background:#f1f5f9;padding:.1rem .3rem;border-radius:.25rem;word-break:break-all}</style></head>
<body><h1>This page was not archived</h1><p>The link you followed points to a page of the original website that was not downloaded (outside the crawl limits, blocked, or failed).</p>
<p>Original address: <code id="u"></code></p><p><a id="orig" rel="noopener">Open the live page</a> · <a href="javascript:history.back()">Go back</a></p>
<script>var u=new URLSearchParams(location.search).get("u")||"";document.getElementById("u").textContent=u;if(/^https?:\\/\\//i.test(u))document.getElementById("orig").href=u;</script></body></html>`;

export class Crawler extends EventEmitter {
  status: CrawlStatus = "idle";
  readonly opts: CrawlOptions;
  readonly startUrl: string;
  error?: string;
  stopReason?: string;

  private allowPrivate: boolean;
  private workDir: string;
  private rawDir: string;
  private siteDir: string;
  private reportDir: string;
  private zipPath: string;
  private resume: boolean;

  private scope!: Scope;
  private assets!: AssetManager;
  private registry = new PathRegistry();
  private throttle = new HostThrottle();
  private sem: Semaphore;
  private renderer: Renderer | null = null;
  private effectiveMode: "fast" | "js" | "full";
  private robotsCache = new Map<string, Promise<Robots | null>>();
  private ctrl = new AbortController();

  private pageNorm: NormalizeOptions;
  private assetNorm: NormalizeOptions;

  private queue: QueueItem[] = [];
  private inflightItems = new Set<QueueItem>();
  private discovered = new Map<string, Discovered>();
  private pages = new Map<string, PageRecord>();
  private pageAlias = new Map<string, string>();
  private contentHashes = new Map<string, string>();
  private variants = new Map<string, Set<string>>();
  private externalLinks = new Set<string>();
  private skipped: Array<{ url: string; reason: string }> = [];
  private skippedKeys = new Set<string>();
  private failures: FailureRecord[] = [];
  private unsupported = {
    forms: [] as Array<{ page: string; action: string; method: string }>,
    apiCalls: new Set<string>(),
    externalEmbeds: new Set<string>(),
    renderFailures: [] as string[],
    notes: [] as string[],
  };
  private enqueued = 0;
  private pageSeq = 0;
  private counters = { crawled: 0, failed: 0, skipped: 0, duplicateUrls: 0, duplicateAssets: 0, assetsDiscovered: 0, assetsDownloaded: 0, assetsFailed: 0 };
  private bytes = 0;
  private samples: Array<{ t: number; b: number }> = [];
  private maxDepthReached = 0;
  private current = new Set<string>();
  private inflight = 0;
  private paused = false;
  private cancelled = false;
  private gateWaiters: Array<() => void> = [];
  private activeAccum = 0;
  private segStart = 0;
  private startedAt = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  private lastStatsEmit = 0;
  private lastSave = 0;
  private visual: VisualRow[] | undefined;
  private visualNote?: string;
  private startNormalized = "";

  constructor(startUrl: string, options: Partial<CrawlOptions>, internal: CrawlerInternal) {
    super();
    this.startUrl = startUrl.trim();
    this.opts = sanitizeOptions(options);
    this.allowPrivate = !!internal.allowPrivateNetworks;
    this.workDir = internal.workDir;
    this.rawDir = path.join(this.workDir, "raw");
    this.siteDir = path.join(this.workDir, "site");
    this.reportDir = path.join(this.workDir, "report");
    this.zipPath = path.join(this.workDir, "site.zip");
    this.resume = !!internal.resume;
    this.effectiveMode = this.opts.renderMode;
    this.sem = new Semaphore(Math.max(2, this.opts.concurrency * 3));
    this.pageNorm = {
      keepQuery: this.opts.crawlQueryParams,
      stripParams: new Set(this.opts.stripParams),
      denyParams: new Set(this.opts.denyParams),
      allowParams: new Set(this.opts.allowParams),
    };
    this.assetNorm = { keepQuery: true, stripParams: new Set(this.opts.stripParams), denyParams: new Set(), allowParams: new Set() };
    this.setMaxListeners(50);
  }

  // ---------- public control ----------

  pause() {
    if (this.status !== "running") return;
    this.activeAccum += Date.now() - this.segStart;
    this.paused = true;
    this.setStatus("paused");
    this.log("INFO", "Paused");
  }

  resumeCrawl() {
    if (this.status !== "paused") return;
    this.paused = false;
    this.segStart = Date.now();
    this.setStatus("running");
    this.log("INFO", "Resumed");
    this.releaseGate();
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.ctrl.abort();
    this.log("WARN", "Cancellation requested — finishing in-flight work and packaging what was downloaded");
    this.releaseGate();
  }

  get outputZip() {
    return this.zipPath;
  }
  get outputReportDir() {
    return this.reportDir;
  }

  getStats(): CrawlStats {
    const now = Date.now();
    while (this.samples.length && this.samples[0].t < now - 5000) this.samples.shift();
    const speed = this.samples.reduce((s, x) => s + x.b, 0) / 5;
    const remaining = this.queue.length + this.inflight;
    const done = this.counters.crawled + this.counters.failed;
    const progress = this.status === "completed" ? 1 : done + remaining > 0 ? done / (done + remaining) : 0;
    return {
      pagesDiscovered: this.discovered.size,
      pagesCrawled: this.counters.crawled,
      pagesRemaining: remaining,
      pagesFailed: this.counters.failed,
      pagesSkipped: this.counters.skipped,
      assetsDiscovered: this.counters.assetsDiscovered,
      assetsDownloaded: this.counters.assetsDownloaded,
      assetsFailed: this.counters.assetsFailed,
      duplicateUrls: this.counters.duplicateUrls,
      duplicateAssets: this.counters.duplicateAssets,
      externalLinks: this.externalLinks.size,
      currentUrls: [...this.current].slice(0, 8),
      bytesDownloaded: this.bytes,
      speedBps: Math.round(speed),
      maxDepthReached: this.maxDepthReached,
      progress,
      elapsedMs: this.activeMs(),
      status: this.status,
      stopReason: this.stopReason,
    };
  }

  // ---------- internals ----------

  private activeMs() {
    return this.activeAccum + (this.status === "running" ? Date.now() - this.segStart : 0);
  }

  private setStatus(s: CrawlStatus) {
    this.status = s;
    this.emit("status", s);
    this.emitStats(true);
  }

  private log(tag: LogTag, message: string) {
    const ev: LogEvent = { t: Date.now(), tag, message };
    this.emit("log", ev);
    this.emitStats();
  }

  private emitStats(force = false) {
    const now = Date.now();
    if (force || now - this.lastStatsEmit >= 250) {
      this.lastStatsEmit = now;
      this.emit("stats", this.getStats());
      return;
    }
    if (!this.statsTimer) {
      this.statsTimer = setTimeout(() => {
        this.statsTimer = null;
        this.lastStatsEmit = Date.now();
        this.emit("stats", this.getStats());
      }, 260);
      this.statsTimer.unref?.();
    }
  }

  private releaseGate() {
    const w = this.gateWaiters;
    this.gateWaiters = [];
    w.forEach((f) => f());
  }

  private async gate() {
    while (this.paused && !this.cancelled) await new Promise<void>((r) => this.gateWaiters.push(r));
  }

  private addBytes(n: number) {
    this.bytes += n;
    this.samples.push({ t: Date.now(), b: n });
  }

  private remainingBytes() {
    return this.opts.maxTotalSize - this.bytes;
  }

  private addSkipped(url: string, reason: string) {
    if (this.skippedKeys.has(url)) return;
    this.skippedKeys.add(url);
    this.counters.skipped++;
    if (this.skipped.length < 5000) this.skipped.push({ url, reason });
    this.log("SKIP", `${url} — ${reason}`);
  }

  private addFailure(f: FailureRecord) {
    if (this.failures.length < 10000) this.failures.push(f);
  }

  private async fetchUrl(url: string, maxBytes: number, validate?: (u: URL) => void): Promise<HttpResult & { attempts: number }> {
    await this.sem.acquire();
    try {
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        /* handled by http layer */
      }
      const robots = await this.robotsFor(url).catch(() => null);
      const delay = Math.max(this.opts.delayMs, this.opts.respectRobots && robots ? Math.min(10000, robots.crawlDelayMs) : 0);
      await this.throttle.wait(host, delay, this.ctrl.signal);
      return await fetchWithRetry(url, {
        allowPrivate: this.allowPrivate,
        timeoutMs: this.opts.requestTimeoutMs,
        maxBytes,
        signal: this.ctrl.signal,
        retries: this.opts.retries,
        retryBaseMs: this.opts.retryBaseMs,
        validateRedirect: validate,
        onRetry: (attempt, reason, wait) => this.log("RETRY", `${url} — ${reason}; retry ${attempt}/${this.opts.retries} in ${wait}ms`),
      });
    } finally {
      this.sem.release();
    }
  }

  private robotsFor(url: string): Promise<Robots | null> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return Promise.resolve(null);
    }
    let p = this.robotsCache.get(origin);
    if (!p) {
      p = (async () => {
        try {
          // robots.txt itself is fetched without delay/robots recursion.
          const res = await fetchWithRetry(origin + "/robots.txt", {
            allowPrivate: this.allowPrivate,
            timeoutMs: this.opts.requestTimeoutMs,
            maxBytes: 512 * 1024,
            signal: this.ctrl.signal,
            retries: 1,
            retryBaseMs: this.opts.retryBaseMs,
          });
          if (res.status === 200) return Robots.parse(res.body.toString("utf8"));
          return null; // 4xx => no restrictions
        } catch {
          return null;
        }
      })();
      this.robotsCache.set(origin, p);
    }
    return p;
  }

  // ---------- URL intake ----------

  /** Evaluates a discovered URL and queues it if it is in scope. */
  private consider(raw: string, depth: number, referrer: string, force = false) {
    const norm = normalizeUrl(raw, undefined, this.pageNorm);
    if (!norm) {
      return;
    }
    const u = new URL(norm);
    const key = urlKey(norm);
    if (!this.scope.isSameSite(u)) {
      if (this.externalLinks.size < 20000) this.externalLinks.add(norm);
      return;
    }
    const known = this.discovered.get(key);
    if (known) {
      if (raw !== norm && raw.replace(/#.*$/, "") !== norm && raw.replace(/#.*$/, "") !== norm + "/") this.counters.duplicateUrls++;
      return;
    }
    const reject = (reason: string, record = true) => {
      if (record) {
        this.discovered.set(key, { url: norm, status: "skipped", depth, referrer, reason });
      }
      this.addSkipped(norm, reason);
    };
    if (!force) {
      const sc = this.scope.check(u);
      if (!sc.ok) return reject(sc.reason, false);
      const trap = detectTrap(u);
      if (trap) return reject(`URL trap: ${trap}`, false);
      if (u.search) {
        if ([...u.searchParams.keys()].length > this.opts.maxQueryParams) return reject("too many query parameters", false);
        const pk = u.origin + u.pathname;
        let set = this.variants.get(pk);
        if (!set) this.variants.set(pk, (set = new Set()));
        if (set.size >= this.opts.maxQueryVariantsPerPath) return reject(`query variant limit (${this.opts.maxQueryVariantsPerPath}) reached for ${u.pathname}`, false);
        set.add(u.search);
      }
      if (depth > this.opts.maxDepth) return reject(`beyond max depth (${this.opts.maxDepth})`);
    }
    if (this.enqueued >= this.opts.maxPages) return reject(`max pages (${this.opts.maxPages}) reached`);
    this.enqueued++;
    this.discovered.set(key, { url: norm, status: "queued", depth, referrer });
    this.queue.push({ url: norm, key, depth, referrer });
    this.log("FOUND", norm);
  }

  // ---------- main run ----------

  async run(): Promise<CrawlResult> {
    this.startedAt = Date.now();
    this.segStart = this.startedAt;
    this.status = "running";
    this.emit("status", "running");
    try {
      await fs.promises.mkdir(this.rawDir, { recursive: true });
      await fs.promises.mkdir(this.siteDir, { recursive: true });
      const start = await assertPublicUrl(this.startUrl, this.allowPrivate);
      const sn = normalizeUrl(start.href, undefined, this.pageNorm);
      if (!sn) throw new Error("The start URL contains a denied query parameter or is invalid");
      this.startNormalized = sn;
      this.scope = new Scope(new URL(sn), this.opts);
      this.assets = new AssetManager({
        siteDir: this.siteDir,
        registry: this.registry,
        scope: this.scope,
        primaryHost: () => this.scope.baseHost,
        primaryPort: () => this.scope.basePort,
        allowPrivate: this.allowPrivate,
        externalAssets: this.opts.externalAssets,
        maxFileSize: this.opts.maxFileSize,
        normalize: (raw) => normalizeUrl(raw, undefined, this.assetNorm),
        fetch: (url, maxBytes) => this.fetchUrl(url, maxBytes),
        remainingBytes: () => this.remainingBytes(),
        addBytes: (n) => this.addBytes(n),
        log: (tag, msg) => this.log(tag, msg),
        onDiscovered: () => this.counters.assetsDiscovered++,
        onDownloaded: () => this.counters.assetsDownloaded++,
        onFailed: () => this.counters.assetsFailed++,
        onDuplicate: () => this.counters.duplicateAssets++,
        onFailure: (f) => this.addFailure(f),
        isCancelled: () => this.cancelled,
      });

      if (this.resume && (await this.loadState())) {
        this.log("INFO", `Resumed saved crawl: ${this.pages.size} pages already stored, ${this.queue.length} queued`);
      } else {
        const key = urlKey(sn);
        this.enqueued = 1;
        this.discovered.set(key, { url: sn, status: "queued", depth: 0 });
        this.queue.push({ url: sn, key, depth: 0 });
        this.log("FOUND", sn);
      }

      if (this.opts.renderMode !== "fast" || this.opts.visualCompare) {
        this.renderer = await Renderer.create(this.allowPrivate);
        if (!this.renderer) {
          if (this.opts.renderMode !== "fast") {
            this.effectiveMode = "fast";
            this.log("WARN", `Chromium unavailable (${Renderer.lastError}); falling back to fast HTML mode`);
            this.unsupported.notes.push(`JavaScript rendering was requested but Chromium could not be launched (${Renderer.lastError}). Pages were fetched as static HTML.`);
          }
          if (this.opts.visualCompare) this.visualNote = `Visual comparison skipped: Chromium unavailable (${Renderer.lastError}).`;
        }
      }

      if (this.opts.useSitemap && !this.resume) await this.discoverSitemaps(start);

      const workers = Array.from({ length: this.opts.concurrency }, () => this.worker());
      await Promise.all(workers);
      return await this.finalize();
    } catch (e) {
      const err = e as Error;
      this.error = err instanceof SsrfError ? `Blocked by security policy: ${err.message}` : err.message;
      this.log("FAILED", this.error);
      await this.renderer?.close();
      if (this.status === "running" || this.status === "paused") {
        this.activeAccum = this.activeMs();
        this.status = "failed";
        this.emit("status", "failed");
      }
      this.emitStats(true);
      return { status: "failed", error: this.error, stats: this.getStats() };
    }
  }

  private async discoverSitemaps(start: URL) {
    const origin = start.origin;
    const robots = await this.robotsFor(origin + "/");
    const todo = [...new Set([...(robots?.sitemaps ?? []), origin + "/sitemap.xml", origin + "/sitemap_index.xml"])];
    const seen = new Set<string>();
    let fetched = 0;
    let urls = 0;
    const cap = this.opts.maxPages * 3;
    while (todo.length && fetched < 25 && !this.cancelled) {
      const sm = todo.shift()!;
      if (seen.has(sm)) continue;
      seen.add(sm);
      let su: URL;
      try {
        su = new URL(sm);
      } catch {
        continue;
      }
      if (!this.scope.isSameSite(su)) continue;
      try {
        const res = await this.fetchUrl(sm, 10 * 1024 * 1024, (u) => {
          if (!this.scope.isSameSite(u)) throw new Error("sitemap redirect leaves scope");
        });
        if (res.status !== 200) continue;
        fetched++;
        const parsed = parseSitemap(res.body);
        if (!parsed.urls.length && !parsed.sitemaps.length) continue;
        this.log("INFO", `Sitemap ${sm}: ${parsed.urls.length} URLs, ${parsed.sitemaps.length} nested sitemaps`);
        todo.push(...parsed.sitemaps);
        for (const raw of parsed.urls) {
          if (urls++ >= cap) break;
          this.consider(raw, 1, sm);
        }
      } catch {
        /* sitemap is optional */
      }
    }
  }

  private limitReached(): string | null {
    if (this.activeMs() > this.opts.maxDurationMs) return `time limit (${Math.round(this.opts.maxDurationMs / 1000)}s) reached`;
    if (this.bytes >= this.opts.maxTotalSize) return `total size limit (${this.opts.maxTotalSize} bytes) reached`;
    return null;
  }

  private async worker() {
    while (!this.cancelled) {
      await this.gate();
      if (this.cancelled) break;
      const lim = this.limitReached();
      if (lim) {
        if (!this.stopReason) {
          this.stopReason = `Stopped early: ${lim}`;
          this.log("WARN", this.stopReason);
        }
        break;
      }
      const item = this.queue.shift();
      if (!item) {
        if (this.inflight === 0) break;
        await sleep(20);
        continue;
      }
      const d = this.discovered.get(item.key);
      if (d && d.status !== "queued") continue; // already handled through a redirect/alias
      this.inflight++;
      this.inflightItems.add(item);
      try {
        await this.processPage(item);
      } catch (e) {
        this.pageFailed(item, e as Error);
      } finally {
        this.inflight--;
        this.inflightItems.delete(item);
        this.current.delete(item.url);
        this.emitStats();
        if (Date.now() - this.lastSave > 3000) void this.saveState();
      }
    }
  }

  private pageFailed(item: QueueItem, e: Error, status?: number) {
    const d = this.discovered.get(item.key);
    if (this.cancelled && (e instanceof HttpError ? e.kind === "aborted" : true)) {
      if (d) d.status = "queued";
      this.queue.unshift(item);
      return;
    }
    if (d) {
      d.status = "failed";
      d.reason = e.message;
    }
    this.counters.failed++;
    this.addFailure({ url: item.url, kind: "page", status, error: e.message, referrer: item.referrer, attempts: (e as { attempts?: number }).attempts });
    this.log("FAILED", `${item.url} — ${e.message}`);
  }

  private async processPage(item: QueueItem) {
    const { url, key, depth } = item;
    const d = this.discovered.get(key)!;
    d.status = "crawling";
    this.current.add(url);
    this.log("CRAWLING", url);
    const u = new URL(url);

    if (this.opts.respectRobots) {
      const robots = await this.robotsFor(url);
      if (robots && !robots.allowed(u.pathname + u.search)) {
        d.status = "skipped";
        d.reason = "blocked by robots.txt";
        this.addSkipped(url, "blocked by robots.txt");
        return;
      }
    }

    const remaining = this.remainingBytes();
    if (remaining <= 0) throw new Error("total size quota reached");
    const res = await this.fetchUrl(url, Math.min(this.opts.maxFileSize, remaining), (next) => {
      if (depth > 0 && !this.scope.isSameSite(next)) throw new Error("redirect leaves the authorised domain scope");
    });
    let finalUrlObj = new URL(res.url);
    if (depth === 0 && !this.scope.isSameSite(finalUrlObj)) {
      this.scope.rebase(finalUrlObj);
      this.log("INFO", `Start URL redirected to ${finalUrlObj.host}; crawl scope updated`);
    }
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`HTTP ${res.status}`) as Error & { attempts?: number };
      err.attempts = res.attempts;
      return this.pageFailed(item, err, res.status);
    }
    const ct = res.contentType;
    const looksHtml = /html|xhtml/.test(ct) || (!ct && /^\s*<(!doctype|html)/i.test(res.body.subarray(0, 200).toString("latin1")));
    if (!looksHtml) {
      // A "page" URL that is really a file (download link, API response, image).
      await this.assets.ingest(res.url, res, item.referrer ?? url);
      d.status = "crawled";
      this.counters.crawled++;
      this.log("COMPLETE", `${url} (file, ${ct || "unknown type"})`);
      return;
    }

    let html = decodeHtml(res.body, ct);
    let renderedWith = "fast";
    let networkAssets: string[] = [];
    let routes: string[] = [];
    if (this.renderer && this.effectiveMode !== "fast") {
      try {
        const r = await this.renderer.render(res.url, { mode: this.effectiveMode, timeoutMs: this.opts.requestTimeoutMs, signal: this.ctrl.signal });
        html = r.html;
        networkAssets = r.networkAssets;
        routes = r.routes;
        r.apiCalls.forEach((a) => this.unsupported.apiCalls.add(a));
        renderedWith = this.effectiveMode;
      } catch (e) {
        if (this.cancelled) throw e;
        const msg = (e as Error).message.split("\n")[0];
        this.unsupported.renderFailures.push(`${url}: ${msg}`);
        this.log("WARN", `Render failed for ${url} (${msg}); using static HTML`);
        renderedWith = "fast (render failed)";
      }
    }

    // Redirect aliasing: the page may live at a different URL than requested.
    const finalNorm = normalizeUrl(res.url, undefined, this.pageNorm) ?? url;
    const finalKey = urlKey(finalNorm);
    finalUrlObj = new URL(finalNorm);
    if (finalKey !== key) {
      this.pageAlias.set(key, finalKey);
      const other = this.discovered.get(finalKey);
      if (other && other.status !== "queued") {
        d.status = "duplicate";
        this.counters.duplicateUrls++;
        this.log("DUP", `${url} redirects to already known ${finalNorm}`);
        return;
      }
      this.discovered.set(finalKey, { url: finalNorm, status: "crawling", depth, referrer: item.referrer });
      d.status = "duplicate";
      this.counters.duplicateUrls++;
    }

    // Identical content under another URL (e.g. ?page=1 vs /, SPA shells in fast mode).
    const ch = crypto.createHash("sha256").update(html).digest("hex");
    const sameAs = this.contentHashes.get(ch);
    if (sameAs && sameAs !== finalKey) {
      this.pageAlias.set(finalKey, sameAs);
      const dd = this.discovered.get(finalKey);
      if (dd) dd.status = "duplicate";
      this.counters.duplicateUrls++;
      this.log("DUP", `${finalNorm} has identical content to ${sameAs}`);
      return;
    }
    this.contentHashes.set(ch, finalKey);

    const htmlBytes = Buffer.byteLength(html);
    if (htmlBytes > this.remainingBytes()) throw new Error("total size quota reached");
    const ex = extractFromHtml(html, res.url);

    // Links
    const next = depth + 1;
    for (const l of ex.links) this.consider(l, next, finalNorm);
    for (const l of routes) this.consider(l, next, finalNorm);
    if (ex.canonical) this.consider(ex.canonical, depth, finalNorm);
    for (const doc of ex.docs) {
      try {
        const du = new URL(doc);
        if (this.scope.isSameSite(du) && isStaticFileUrl(du)) ex.assets.push(doc);
        else if (this.externalLinks.size < 20000) this.externalLinks.add(doc);
      } catch {
        /* ignore */
      }
    }
    for (const f of ex.forms) {
      if ((f.method !== "get" || f.action) && this.unsupported.forms.length < 200) this.unsupported.forms.push({ page: finalNorm, action: f.action, method: f.method });
    }
    ex.embeds.forEach((e) => {
      try {
        if (!this.scope.isSameSite(new URL(e))) this.unsupported.externalEmbeds.add(e);
      } catch {
        /* ignore */
      }
    });

    // Save page (raw, rewritten at the end once every route is known)
    const idx = ++this.pageSeq;
    const rawFile = `${idx}.html`;
    await fs.promises.writeFile(path.join(this.rawDir, rawFile), html);
    const localPath = this.registry.reserve(pageLocalPath(finalUrlObj, this.scope.baseHost, this.scope.basePort), finalKey);
    this.pages.set(finalKey, {
      key: finalKey,
      url,
      finalUrl: res.url,
      localPath,
      status: "ok",
      httpStatus: res.status,
      title: ex.title,
      depth,
      rawFile,
      renderedWith,
      bytes: htmlBytes,
    });
    this.addBytes(htmlBytes);
    this.maxDepthReached = Math.max(this.maxDepthReached, depth);

    if (this.opts.downloadAssets) {
      const list = [...new Set([...ex.assets, ...ex.jsAssets, ...networkAssets])];
      const q = [...list];
      const pool = Array.from({ length: Math.min(6, q.length) }, async () => {
        for (let a = q.shift(); a !== undefined; a = q.shift()) {
          if (this.cancelled) return;
          await this.assets.download(a, finalNorm, 0);
        }
      });
      await Promise.all(pool);
    }
    const dFinal = this.discovered.get(finalKey) ?? d;
    dFinal.status = "crawled";
    if (finalKey !== key) d.status = "duplicate";
    this.counters.crawled++;
    this.log("COMPLETE", finalNorm);
  }

  // ---------- finalisation ----------

  private resolveAlias(key: string): string {
    let k = key;
    for (let i = 0; i < 6; i++) {
      const n = this.pageAlias.get(k);
      if (!n || n === k) break;
      k = n;
    }
    return k;
  }

  private async finalize(): Promise<CrawlResult> {
    const wasCancelled = this.cancelled;
    this.activeAccum = this.activeMs();
    this.status = "running";
    this.log("INFO", wasCancelled ? "Packaging partial download…" : "Crawl finished — rewriting links for offline use…");
    await this.saveState();

    // Anything still queued was never fetched.
    const leftover = this.queue.splice(0);
    for (const it of leftover) {
      const d = this.discovered.get(it.key);
      if (d && d.status === "queued") {
        d.status = "skipped";
        d.reason = wasCancelled ? "crawl cancelled" : (this.stopReason ?? "not reached");
        this.addSkipped(it.url, d.reason);
      }
    }

    const startKey = urlKey(this.startNormalized);
    const startTarget = this.pages.get(this.resolveAlias(startKey));
    if (this.pages.size === 0) {
      await this.renderer?.close();
      const first = this.failures.find((f) => f.kind === "page");
      this.error = first ? `Could not download the start page: ${first.error}` : (this.skipped[0]?.reason ? `Start page was skipped: ${this.skipped[0].reason}` : "No pages could be downloaded");
      await this.writeAllReports("failed");
      this.activeAccum = this.activeMs();
      this.status = wasCancelled ? "cancelled" : "failed";
      this.emit("status", this.status);
      this.emitStats(true);
      return { status: this.status, error: this.error, reportDir: this.reportDir, stats: this.getStats() };
    }

    await this.rewriteAll();

    // Offline helpers
    await fs.promises.mkdir(path.join(this.siteDir, "__offline__"), { recursive: true });
    await fs.promises.writeFile(path.join(this.siteDir, "__offline__", "missing.html"), MISSING_PAGE);
    const routeMap: Record<string, string> = {};
    for (const [k, p] of this.pages) routeMap[p.finalUrl] = p.localPath;
    for (const [from] of this.pageAlias) {
      const t = this.pages.get(this.resolveAlias(from));
      if (t) routeMap[this.discovered.get(from)?.url ?? from] = t.localPath;
    }
    await fs.promises.writeFile(path.join(this.siteDir, "__offline__", "route-map.json"), JSON.stringify(routeMap, null, 2));
    if (startTarget && startTarget.localPath !== "index.html" && !fs.existsSync(path.join(this.siteDir, "index.html"))) {
      const href = startTarget.localPath;
      await fs.promises.writeFile(
        path.join(this.siteDir, "index.html"),
        `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}"><title>Redirecting</title><a href="${href}">Open the archived start page</a>`,
      );
    }

    // Visual comparison (optional)
    if (this.opts.visualCompare && this.renderer && !wasCancelled) {
      const list = [...this.pages.values()].sort((a, b) => a.depth - b.depth).slice(0, this.opts.visualMaxPages);
      this.log("INFO", `Visual comparison of ${list.length} page(s) at desktop/tablet/mobile…`);
      try {
        this.visual = await runVisualComparison(this.renderer, {
          siteDir: this.siteDir,
          reportDir: this.reportDir,
          pages: list.map((p) => ({ url: p.finalUrl, localPath: p.localPath })),
          timeoutMs: this.opts.requestTimeoutMs,
          signal: this.ctrl.signal,
          log: (m) => this.log("INFO", m),
        });
      } catch (e) {
        this.visualNote = `Visual comparison failed: ${(e as Error).message}`;
      }
    }
    await this.renderer?.close();

    await this.writeAllReports(wasCancelled ? "cancelled" : "completed");
    this.log("INFO", "Creating ZIP archive…");
    const zip = await createZip(this.zipPath, [
      { dir: this.siteDir, prefix: "" },
      { dir: this.reportDir, prefix: "_report" },
    ]);
    this.log("INFO", `ZIP ready: ${zip.entries} files, ${zip.bytes} bytes`);
    await fs.promises.rm(this.siteDir, { recursive: true, force: true });
    await fs.promises.rm(this.rawDir, { recursive: true, force: true });
    await fs.promises.rm(path.join(this.workDir, "state.json"), { force: true });

    this.status = wasCancelled ? "cancelled" : "completed";
    this.emit("status", this.status);
    this.emitStats(true);
    return { status: this.status, zipPath: this.zipPath, reportDir: this.reportDir, stats: this.getStats() };
  }

  private async rewriteAll() {
    const targets = new Map<string, string>();
    for (const [k, p] of this.pages) targets.set(k, p.localPath);
    for (const [from] of this.pageAlias) {
      const t = targets.get(this.resolveAlias(from));
      if (t) targets.set(from, t);
    }
    const missingLink = (from: string, abs: string) => `${relativeLink(from, "__offline__/missing.html")}?u=${encodeURIComponent(abs)}`;
    const assetPath = (abs: string): string | null => {
      const n = normalizeUrl(abs, undefined, this.assetNorm);
      if (!n) return null;
      const rec = this.assets.get(urlKey(n));
      return rec && (rec.status === "ok" || rec.status === "duplicate") && rec.localPath ? rec.localPath : null;
    };
    const banner = (url: string) => `Archived from ${url} on ${new Date().toISOString()} by SiteArchiver 2.0`;

    for (const page of this.pages.values()) {
      const raw = await fs.promises.readFile(path.join(this.rawDir, page.rawFile), "utf8");
      const from = page.localPath;
      const out = rewriteHtml(
        raw,
        page.finalUrl,
        (abs, kind) => {
          if (kind === "canonical" || kind === "discover") return null;
          let hash = "";
          let isStatic = false;
          let sameSite = false;
          try {
            const pu = new URL(abs);
            hash = pu.hash;
            isStatic = isStaticFileUrl(pu);
            sameSite = this.scope.isSameSite(pu);
          } catch {
            return null;
          }
          if (kind === "asset" || isStatic) {
            const a = assetPath(abs);
            if (a) return relativeLink(from, a);
            // Not archived: point at the live URL rather than a path that would resolve against the local disk root.
            return kind === "asset" ? abs : sameSite ? missingLink(from, abs) : null;
          }
          const n = normalizeUrl(abs, undefined, this.pageNorm);
          if (n) {
            const t = targets.get(urlKey(n));
            if (t) return relativeLink(from, t) + hash;
          }
          return sameSite ? missingLink(from, abs) : null;
        },
        (rawRef, base) => {
          try {
            const href = new URL(rawRef, base).href;
            const a = assetPath(href);
            return a ? relativeLink(from, a) : href;
          } catch {
            return null;
          }
        },
        { stripScripts: page.renderedWith === "js", banner: banner(page.finalUrl) },
      );
      const full = safeJoin(this.siteDir, page.localPath);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, out);
    }
    if (this.pages.size && [...this.pages.values()].some((p) => p.renderedWith === "js")) {
      this.unsupported.notes.push("In JavaScript rendering mode pages are saved as rendered snapshots: scripts are removed, so client-side interactivity (menus, sliders, carousels, live data) is static offline. Use full rendering mode to keep scripts (works only where the scripts do not depend on a server or on http(s) routing).");
    }
    this.unsupported.notes.push("Forms, search boxes, logins, comments and any server-side functionality cannot work in an offline copy.");
    this.unsupported.notes.push("Scripts are not rewritten: asset URLs constructed at runtime inside JavaScript may still point at the live site.");

    // Stylesheets: rewrite url() and @import relative to their own location.
    for (const css of this.assets.cssFiles()) {
      try {
        const full = safeJoin(this.siteDir, css.localPath);
        const text = decodeHtml(await fs.promises.readFile(full), css.contentType);
        const out = rewriteCss(text, (rawRef) => {
          try {
            const href = new URL(rawRef, css.url).href;
            const a = assetPath(href);
            return a ? relativeLink(css.localPath, a) : href;
          } catch {
            return null;
          }
        });
        if (out !== text) await fs.promises.writeFile(full, out);
      } catch (e) {
        this.log("WARN", `Could not rewrite ${css.localPath}: ${(e as Error).message}`);
      }
    }
  }

  private async writeAllReports(status: string) {
    const assets: AssetRecord[] = [...this.assets.records.values()];
    const discovered: DiscoveredRow[] = [...this.discovered.values()].map((d) => ({ url: d.url, status: d.status, reason: d.reason, depth: d.depth, referrer: d.referrer }));
    const pages: PageRow[] = [...this.pages.values()].map((p) => ({
      url: p.url,
      finalUrl: p.finalUrl,
      localPath: p.localPath,
      status: "ok",
      httpStatus: p.httpStatus,
      depth: p.depth,
      title: p.title,
      bytes: p.bytes,
      renderedWith: p.renderedWith,
    }));
    for (const [from, to] of this.pageAlias) {
      const t = this.pages.get(this.resolveAlias(from));
      const d = this.discovered.get(from);
      if (t && d) pages.push({ url: d.url, finalUrl: d.url, localPath: t.localPath, status: "alias", depth: d.depth, title: "", bytes: 0, renderedWith: "-", aliasOf: t.finalUrl });
    }
    const data: ReportData = {
      startUrl: this.startNormalized || this.startUrl,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: this.activeMs(),
      status,
      stopReason: this.stopReason,
      options: this.opts,
      requestedRenderMode: this.opts.renderMode,
      effectiveRenderMode: this.effectiveMode,
      stats: this.getStats(),
      pages,
      discovered,
      failures: this.failures,
      skipped: this.skipped,
      externalLinks: [...this.externalLinks],
      assets,
      unsupported: {
        forms: this.unsupported.forms,
        apiCalls: [...this.unsupported.apiCalls],
        externalEmbeds: [...this.unsupported.externalEmbeds],
        renderFailures: this.unsupported.renderFailures,
        notes: [...new Set(this.unsupported.notes)],
      },
      contentBytes: this.bytes,
      visual: this.visual,
      visualNote: this.visualNote ?? (this.opts.visualCompare ? undefined : "Visual comparison was not requested."),
    };
    await writeReports(this.reportDir, data);
  }

  // ---------- resume support ----------

  private async saveState() {
    this.lastSave = Date.now();
    try {
      const state = {
        version: 1,
        startUrl: this.startUrl,
        queue: [...this.inflightItems, ...this.queue],
        discovered: [...this.discovered.entries()].map(([k, v]) => [k, v.status === "crawling" ? { ...v, status: "queued" } : v]),
        pages: [...this.pages.values()],
        pageAlias: [...this.pageAlias.entries()],
        contentHashes: [...this.contentHashes.entries()],
        variants: [...this.variants.entries()].map(([k, v]) => [k, [...v]]),
        externalLinks: [...this.externalLinks],
        skipped: this.skipped,
        failures: this.failures,
        assets: [...this.assets.records.values()].filter((a) => a.status !== "skipped" || a.error),
        enqueued: this.enqueued,
        pageSeq: this.pageSeq,
        counters: this.counters,
        bytes: this.bytes,
        maxDepthReached: this.maxDepthReached,
        activeMs: this.activeMs(),
        scope: { baseHost: this.scope.baseHost, basePort: this.scope.basePort },
      };
      await fs.promises.writeFile(path.join(this.workDir, "state.json"), JSON.stringify(state));
    } catch {
      /* best effort */
    }
  }

  private async loadState(): Promise<boolean> {
    try {
      const s = JSON.parse(await fs.promises.readFile(path.join(this.workDir, "state.json"), "utf8"));
      if (s.version !== 1) return false;
      this.queue = s.queue;
      this.discovered = new Map(s.discovered);
      this.pages = new Map((s.pages as PageRecord[]).map((p) => [p.key, p]));
      for (const p of this.pages.values()) this.registry.reserve(p.localPath, p.key);
      this.pageAlias = new Map(s.pageAlias);
      this.contentHashes = new Map(s.contentHashes);
      this.variants = new Map((s.variants as Array<[string, string[]]>).map(([k, v]) => [k, new Set(v)]));
      this.externalLinks = new Set(s.externalLinks);
      this.skipped = s.skipped;
      this.skippedKeys = new Set(this.skipped.map((x) => x.url));
      this.failures = s.failures;
      this.assets.restore(s.assets);
      this.enqueued = s.enqueued;
      this.pageSeq = s.pageSeq;
      this.counters = s.counters;
      this.bytes = s.bytes;
      this.maxDepthReached = s.maxDepthReached;
      this.activeAccum = s.activeMs;
      if (s.scope) {
        this.scope.baseHost = s.scope.baseHost;
        this.scope.basePort = s.scope.basePort;
      }
      return true;
    } catch {
      return false;
    }
  }
}
