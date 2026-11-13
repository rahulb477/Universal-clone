import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { AuthProfile } from "./auth";
import { Crawler, type AccessEntry, type AuthHooks, type CrawlRunner } from "./engine";
import type { InteractiveLogin } from "./interactive-login";
import { PublicAssetCache } from "./public-assets";
import { Renderer } from "./renderer";
import { hash6, sanitizeSegment } from "./url";
import { sanitizeOptions, type AuthProfileProgress, type CrawlOptions, type CrawlResult, type CrawlStats, type CrawlStatus, type LogEvent } from "./types";
import { createZip } from "./zip";

export interface CombinedInternal {
  workDir: string;
  allowPrivateNetworks?: boolean;
  profiles: AuthProfile[];
  /** Per-profile session persistence / interactive-login plumbing. */
  hooksFor?: (profile: AuthProfile) => AuthHooks | undefined;
  interactiveLoginTimeoutMs?: number;
}

interface Member {
  profile: { id: string; name: string };
  folder: string;
  crawler: Crawler;
  settled: boolean;
  result?: CrawlResult;
}

interface InventoryEntry {
  url: string;
  depth: number;
  discoveredBy: Set<number>;
}

export interface AccessMatrixRow {
  url: string;
  /** Profiles whose own pages (or the sitemap they could read) contained this URL. */
  discoveredBy: string[];
  /** Profiles whose session was served the page. */
  accessibleBy: string[];
  /** Profiles that were refused (401/403 or bounced to the login page while still signed in). */
  deniedFor: string[];
  /** Profiles for which the request failed for another reason or the URL was skipped. */
  otherOutcome: { profile: string; state: string; reason?: string }[];
  /** True when every profile that could open the page received byte-identical HTML. */
  identicalAcrossProfiles: boolean | null;
  files: Record<string, string>;
}

/**
 * Combined discovery.
 *
 * Every profile gets its own crawler and its own browser context (separate cookies, storage and
 * cache) on one shared browser process. URLs that one profile discovers are offered to every other
 * profile, so the union of all link graphs is explored; each profile then requests the page with
 * *its own* session only, which is what establishes "who can access what".
 *
 * Isolation rules:
 *  - Page bytes are only ever written into the tree of the profile whose session fetched them.
 *  - Only URLs travel between profiles — never cookies, storage, response bodies or headers.
 *  - Assets are requested anonymously once through a shared cache; an asset that needs a session is
 *    fetched per profile and never enters that cache.
 *  - The archive keeps one folder per profile; nothing is merged across accounts.
 */
export class CombinedCrawler extends EventEmitter implements CrawlRunner {
  status: CrawlStatus = "idle";
  private opts: CrawlOptions;
  private members: Member[] = [];
  private inventory = new Map<string, InventoryEntry>();
  private base: Renderer | null = null;
  private cache: PublicAssetCache;
  private cancelled = false;
  private suspended = false;
  private startedAt = 0;
  private lastStats = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  private error?: string;
  private zipBytes = 0;
  readonly zipPath: string;
  readonly reportDir: string;

  constructor(
    private startUrl: string,
    options: Partial<CrawlOptions>,
    private internal: CombinedInternal,
  ) {
    super();
    // Visual comparison re-renders pages anonymously, which is meaningless for signed-in content.
    this.opts = sanitizeOptions({ ...options, visualCompare: false });
    this.zipPath = path.join(internal.workDir, "site.zip");
    this.reportDir = path.join(internal.workDir, "report");
    this.cache = new PublicAssetCache(path.join(internal.workDir, "public-cache"));
    if (internal.profiles.length < 2) throw new Error("Combined discovery needs at least two profiles.");
  }

  private log(tag: LogEvent["tag"], message: string) {
    this.emit("log", { t: Date.now(), tag, message } satisfies LogEvent);
  }

  private setStatus(s: CrawlStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit("status", s);
    this.emitStats(true);
  }

  private emitStats(force = false) {
    const now = Date.now();
    if (!force && now - this.lastStats < 250) return;
    this.lastStats = now;
    this.emit("stats", this.getStats());
  }

  /** The user-facing aggregate: totals across profiles plus one progress row per profile. */
  getStats(): CrawlStats {
    const all = this.members.map((m) => m.crawler.getStats());
    const sum = (f: (s: CrawlStats) => number) => all.reduce((a, s) => a + f(s), 0);
    const profiles: AuthProfileProgress[] = all.flatMap((s) => s.profiles ?? []);
    const done = this.status === "completed" || this.status === "cancelled" || this.status === "failed";
    return {
      pagesDiscovered: this.inventory.size || sum((s) => s.pagesDiscovered),
      pagesCrawled: sum((s) => s.pagesCrawled),
      pagesRemaining: sum((s) => s.pagesRemaining),
      pagesFailed: sum((s) => s.pagesFailed),
      pagesSkipped: sum((s) => s.pagesSkipped),
      assetsDiscovered: sum((s) => s.assetsDiscovered),
      assetsDownloaded: sum((s) => s.assetsDownloaded),
      assetsFailed: sum((s) => s.assetsFailed),
      duplicateUrls: sum((s) => s.duplicateUrls),
      duplicateAssets: sum((s) => s.duplicateAssets),
      externalLinks: Math.max(0, ...all.map((s) => s.externalLinks)),
      currentUrls: all.flatMap((s) => s.currentUrls).slice(0, 8),
      bytesDownloaded: sum((s) => s.bytesDownloaded),
      speedBps: sum((s) => s.speedBps),
      maxDepthReached: Math.max(0, ...all.map((s) => s.maxDepthReached)),
      progress: done ? 1 : all.length ? sum((s) => s.progress) / all.length : 0,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      status: this.status,
      stopReason: all.find((s) => s.stopReason)?.stopReason,
      zipBytes: this.zipBytes || undefined,
      apiEndpoints: sum((s) => s.apiEndpoints ?? 0),
      profiles,
    } as CrawlStats;
  }

  private contribute(from: number, url: string, depth: number) {
    let e = this.inventory.get(url);
    const isNew = !e;
    if (!e) this.inventory.set(url, (e = { url, depth, discoveredBy: new Set() }));
    e.discoveredBy.add(from);
    if (!isNew) return;
    // Offer the URL (and nothing else) to every other profile.
    this.members.forEach((m, i) => {
      if (i !== from && !m.settled) m.crawler.inject(url, depth);
    });
  }

  /** A profile keeps waiting for work while any sibling may still discover URLs. */
  private othersActive(self: number): boolean {
    return this.members.some((m, i) => i !== self && !m.settled && (!m.crawler.workersStarted || m.crawler.busy));
  }

  private refreshStatus() {
    if (["completed", "failed", "cancelled", "interrupted"].includes(this.status) || this.cancelled) return;
    const live = this.members.filter((m) => !m.settled);
    if (live.length && live.every((m) => m.crawler.status === "paused" || !m.crawler.busy) && live.some((m) => m.crawler.status === "paused")) this.setStatus("paused");
    else this.setStatus("running");
  }

  async run(): Promise<CrawlResult> {
    this.startedAt = Date.now();
    this.setStatus("running");
    try {
      await fs.promises.mkdir(this.internal.workDir, { recursive: true });
      this.base = await Renderer.create(!!this.internal.allowPrivateNetworks);
      if (!this.base) throw new Error(`Combined discovery needs Chromium, which could not be started: ${Renderer.lastError}`);
      const used = new Set<string>();
      this.members = this.internal.profiles.map((p, i) => {
        let folder = sanitizeSegment(p.name || `profile-${i + 1}`).replace(/\.+$/, "") || `profile-${i + 1}`;
        if (used.has(folder.toLowerCase())) folder = `${folder}-${hash6(p.id)}`;
        used.add(folder.toLowerCase());
        const crawler = new Crawler(this.startUrl, this.opts, {
          workDir: path.join(this.internal.workDir, "profiles", String(i)),
          allowPrivateNetworks: this.internal.allowPrivateNetworks,
          authProfile: p,
          authHooks: this.internal.hooksFor?.(p),
          interactiveLoginTimeoutMs: this.internal.interactiveLoginTimeoutMs,
          packaging: "tree",
          renderer: this.base!.share(),
          publicAssets: this.cache,
          onDiscovered: (url, depth) => this.contribute(i, url, depth),
          hold: () => !this.cancelled && this.othersActive(i),
        });
        const member: Member = { profile: { id: p.id, name: p.name }, folder, crawler, settled: false };
        crawler.on("log", (e: LogEvent) => this.emit("log", { ...e, message: `[${p.name}] ${e.message}` }));
        crawler.on("stats", () => this.emitStats());
        crawler.on("status", () => this.refreshStatus());
        crawler.on("auth", () => this.emitStats(true));
        crawler.on("interactive-login", (login: InteractiveLogin) => this.emit("interactive-login", login));
        return member;
      });
      this.log("INFO", `Combined discovery across ${this.members.length} isolated profiles`);
      this.statsTimer = setInterval(() => this.emitStats(), 1000);
      await Promise.all(
        this.members.map(async (m) => {
          try {
            m.result = await m.crawler.run();
          } catch (e) {
            m.result = { status: "failed", error: (e as Error).message, stats: m.crawler.getStats() };
          } finally {
            m.settled = true;
            this.refreshStatus();
          }
        }),
      );
      if (this.statsTimer) clearInterval(this.statsTimer);
      if (this.suspended) {
        await this.base.close();
        this.setStatus("interrupted");
        return { status: "interrupted", stats: this.getStats() };
      }
      return await this.package();
    } catch (e) {
      if (this.statsTimer) clearInterval(this.statsTimer);
      this.error = (e as Error).message;
      this.log("FAILED", `Crawl aborted: ${this.error}`);
      await this.base?.close();
      await this.cache.dispose().catch(() => {});
      this.setStatus("failed");
      return { status: "failed", error: this.error, stats: this.getStats() };
    }
  }

  private async package(): Promise<CrawlResult> {
    const ok = this.members.filter((m) => m.result?.siteDir && (m.result.status === "completed" || m.result.status === "cancelled"));
    const matrix = this.buildMatrix();
    await fs.promises.mkdir(this.reportDir, { recursive: true });
    const summary = {
      mode: "combined",
      startUrl: this.startUrl,
      generatedAt: new Date().toISOString(),
      status: this.cancelled ? "cancelled" : ok.length ? "completed" : "failed",
      isolation:
        "Each profile used its own browser context. Only URLs were shared between profiles. Every file under profiles/<name>/ was fetched with that profile's own session, or anonymously when the asset is public.",
      profiles: this.members.map((m) => ({
        name: m.profile.name,
        folder: m.result?.siteDir ? `profiles/${m.folder}` : null,
        status: m.result?.status ?? "failed",
        error: m.result?.error ?? null,
        pagesDownloaded: m.result?.stats.pagesCrawled ?? 0,
        pagesFailed: m.result?.stats.pagesFailed ?? 0,
        assetsDownloaded: m.result?.stats.assetsDownloaded ?? 0,
      })),
      inventory: {
        urls: matrix.length,
        accessibleToAll: matrix.filter((r) => r.accessibleBy.length === this.members.length).length,
        accessibleToSome: matrix.filter((r) => r.accessibleBy.length > 0 && r.accessibleBy.length < this.members.length).length,
        accessibleToNone: matrix.filter((r) => r.accessibleBy.length === 0).length,
        identicalAcrossProfiles: matrix.filter((r) => r.identicalAcrossProfiles === true).length,
      },
      assetSharing: this.cache.stats,
    };
    await fs.promises.writeFile(path.join(this.reportDir, "combined-report.json"), JSON.stringify(summary, null, 2));
    await fs.promises.writeFile(path.join(this.reportDir, "access-matrix.json"), JSON.stringify(matrix, null, 2));
    await fs.promises.writeFile(path.join(this.reportDir, "access-matrix.csv"), matrixCsv(matrix));
    await this.base?.close();
    await this.cache.dispose().catch(() => {});

    if (!ok.length) {
      this.error = this.members.map((m) => `${m.profile.name}: ${m.result?.error ?? m.result?.status ?? "failed"}`).join("; ");
      this.setStatus(this.cancelled ? "cancelled" : "failed");
      return { status: this.status, error: this.error, reportDir: this.reportDir, stats: this.getStats() };
    }
    const landing = path.join(this.internal.workDir, "landing");
    await fs.promises.mkdir(landing, { recursive: true });
    await fs.promises.writeFile(path.join(landing, "index.html"), landingHtml(this.startUrl, ok, matrix));
    this.log("INFO", "Creating ZIP archive…");
    const sources = [{ dir: landing, prefix: "" }, { dir: this.reportDir, prefix: "_report" }];
    for (const m of ok) {
      sources.push({ dir: m.result!.siteDir!, prefix: `profiles/${m.folder}` });
      if (m.result!.reportDir) sources.push({ dir: m.result!.reportDir, prefix: `profiles/${m.folder}/_report` });
    }
    const z = await createZip(this.zipPath, sources);
    this.zipBytes = z.bytes;
    this.log("INFO", `ZIP ready: ${z.entries} files, ${z.bytes} bytes`);
    await fs.promises.rm(landing, { recursive: true, force: true });
    for (const m of ok) await fs.promises.rm(m.result!.siteDir!, { recursive: true, force: true });
    this.setStatus(this.cancelled ? "cancelled" : "completed");
    return { status: this.status, zipPath: this.zipPath, zipEntries: z.entries, reportDir: this.reportDir, stats: this.getStats() };
  }

  private buildMatrix(): AccessMatrixRow[] {
    const reports: Map<string, AccessEntry>[] = this.members.map((m) => new Map(m.crawler.accessReport().map((e) => [e.url, e])));
    const urls = new Set<string>(this.inventory.keys());
    reports.forEach((r) => r.forEach((_, u) => urls.add(u)));
    const rows: AccessMatrixRow[] = [];
    for (const url of [...urls].sort()) {
      const inv = this.inventory.get(url);
      const row: AccessMatrixRow = { url, discoveredBy: [], accessibleBy: [], deniedFor: [], otherOutcome: [], identicalAcrossProfiles: null, files: {} };
      const hashes = new Set<string>();
      this.members.forEach((m, i) => {
        const e = reports[i].get(url);
        if (inv?.discoveredBy.has(i) || (e?.discoveredHere && !inv)) row.discoveredBy.push(m.profile.name);
        if (!e) return;
        if (e.state === "accessible") {
          row.accessibleBy.push(m.profile.name);
          if (e.sha256) hashes.add(e.sha256);
          if (e.localPath) row.files[m.profile.name] = `profiles/${m.folder}/${e.localPath}`;
        } else if (e.state === "denied") row.deniedFor.push(m.profile.name);
        else row.otherOutcome.push({ profile: m.profile.name, state: e.state, reason: e.reason });
      });
      if (row.accessibleBy.length > 1 && hashes.size) row.identicalAcrossProfiles = hashes.size === 1;
      rows.push(row);
    }
    return rows;
  }

  pause() {
    for (const m of this.members) if (!m.settled) m.crawler.pause();
  }

  async resumeCrawl(): Promise<{ awaitingUser: boolean }> {
    let awaitingUser = false;
    const errors: string[] = [];
    for (const m of this.members) {
      if (m.settled) continue;
      try {
        const r = await m.crawler.resumeCrawl();
        awaitingUser = awaitingUser || r.awaitingUser;
      } catch (e) {
        errors.push(`${m.profile.name}: ${(e as Error).message}`);
      }
    }
    this.refreshStatus();
    if (errors.length) throw new Error(errors.join("; "));
    return { awaitingUser };
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const m of this.members) if (!m.settled) m.crawler.cancel();
  }

  suspend() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.suspended = true;
    for (const m of this.members) if (!m.settled) m.crawler.suspend();
  }
}

function csvCell(s: string) {
  const v = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return `"${v.replace(/"/g, '""')}"`;
}

function matrixCsv(rows: AccessMatrixRow[]): string {
  const lines = ["url,discovered_by,accessible_by,denied_for,other,identical_across_profiles"];
  for (const r of rows) {
    lines.push(
      [r.url, r.discoveredBy.join(" | "), r.accessibleBy.join(" | "), r.deniedFor.join(" | "), r.otherOutcome.map((o) => `${o.profile}: ${o.state}`).join(" | "), r.identicalAcrossProfiles === null ? "" : String(r.identicalAcrossProfiles)]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function landingHtml(startUrl: string, members: Member[], matrix: AccessMatrixRow[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Combined archive</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1c1c1c}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ddd;padding:.3rem .5rem;text-align:left;vertical-align:top;word-break:break-all}th{background:#f5f5f5}</style></head><body>
<h1>Combined archive</h1><p>Source: ${esc(startUrl)}. Each signed-in profile has its own, separate offline copy. Nothing was merged across accounts.</p>
<ul>${members.map((m) => `<li><a href="profiles/${encodeURI(m.folder)}/index.html">${esc(m.profile.name)}</a> — ${m.result?.stats.pagesCrawled ?? 0} pages</li>`).join("")}</ul>
<h2>Who can open what</h2><p>Full data: <a href="_report/access-matrix.json">_report/access-matrix.json</a>, <a href="_report/access-matrix.csv">_report/access-matrix.csv</a>.</p>
<table><tr><th>URL</th><th>Discovered by</th><th>Accessible by</th><th>Denied for</th></tr>${matrix
    .slice(0, 500)
    .map((r) => `<tr><td>${esc(r.url)}</td><td>${esc(r.discoveredBy.join(", "))}</td><td>${esc(r.accessibleBy.join(", "))}</td><td>${esc(r.deniedFor.join(", "))}</td></tr>`)
    .join("")}</table></body></html>`;
}
