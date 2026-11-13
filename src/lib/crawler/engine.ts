import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AssetManager, type AssetRecord } from "./assets";
import { decodeHtml, extractFromHtml, rewriteCss, rewriteHtml } from "./parser";
import { fetchWithRetry, HostThrottle, HttpError, sleep, type HttpResult } from "./http";
import { Renderer } from "./renderer";
import type { AuthProfile } from "./auth";
import { ApiCollector, detectNextPage, extractAssetUrlsFromJson, redactUrl, type ApiObservation, type ApiRecord } from "./api-discovery";
import type { InteractiveLogin, SessionState } from "./interactive-login";
import type { PublicAssetCache } from "./public-assets";
import { Robots, parseSitemap } from "./robots";
import { writeReports, type DiscoveredRow, type PageRow, type ReportData } from "./report";
import { assertPublicUrl, safeJoin, SsrfError } from "./security";
import { sanitizeOptions, type AuthenticationStatus, type CrawlOptions, type CrawlResult, type CrawlStats, type CrawlStatus, type FailureRecord, type LogEvent, type LogTag } from "./types";
import { detectTrap, isStaticFileUrl, normalizeUrl, pageLocalPath, PathRegistry, relativeLink, Scope, urlKey, type NormalizeOptions } from "./url";
import { runVisualComparison, type VisualRow } from "./visual";
import { createZip } from "./zip";

export interface CrawlerInternal {
  workDir: string;
  /** Operator-only switch (never reachable from the API): allows crawling private addresses, for tests/intranet use. */
  allowPrivateNetworks?: boolean;
  resume?: boolean;
  /** One isolated authenticated profile per archive/job. Never persisted in crawl options. */
  authProfile?: AuthProfile;
  /** Session persistence and interactive-login plumbing supplied by the host (worker or test). */
  authHooks?: AuthHooks;
  /** How long an interactive (manual / MFA) sign-in may stay open. Default 10 minutes. */
  interactiveLoginTimeoutMs?: number;
  /** "tree" leaves the rewritten site and reports on disk instead of zipping them (combined mode packages several trees). */
  packaging?: "zip" | "tree";
  /** Use this renderer (a `Renderer.share()` of a common browser) instead of launching a browser. */
  renderer?: Renderer;
  /** Called for every in-scope URL this crawler queues itself (combined discovery inventory). */
  onDiscovered?: (url: string, depth: number, referrer?: string) => void;
  /** While this returns true, idle workers wait instead of finishing (sibling crawlers may still contribute URLs). */
  hold?: () => boolean;
  /** Shared anonymous asset cache: assets that are public are downloaded once for all profiles. */
  publicAssets?: PublicAssetCache;
  /** Open interactive sign-ins in a visible window on the worker machine (local desktop use). */
  headedLogin?: boolean;
}

export interface AuthHooks {
  /** A previously saved (already decrypted) browser session for this profile, if one exists. */
  loadSession?: () => Promise<SessionState | null>;
  /**
   * A reusable "Login with Browser" session offered to the job (already decrypted and validated by
   * the host). Tried before `loadSession`; the host falls back to the profile's own login when the
   * site rejects it, so an expired saved login degrades instead of failing the crawl.
   */
  loadSavedProfile?: () => Promise<{ state: SessionState; profileName: string } | null>;
  /**
   * Called when the site rejected a session that came from a reusable profile, so the owner is told
   * their saved login needs renewing. Never receives cookies or tokens.
   */
  onSavedProfileRejected?: (reason: "expired" | "invalid") => Promise<void>;
  /** Persist a freshly captured session. The callee must encrypt it. */
  saveSession?: (state: SessionState) => Promise<void>;
  /** The stored session was rejected by the site and must not be reused. */
  clearSession?: (reason: string) => Promise<void>;
  /** A human has to act (manual login or MFA). The callee exposes the session to its owner only. */
  onInteractiveLogin?: (login: InteractiveLogin) => void;
}

export interface AccessEntry {
  url: string;
  key: string;
  state: "accessible" | "denied" | "failed" | "skipped" | "not-fetched";
  httpStatus?: number;
  reason?: string;
  localPath?: string;
  sha256?: string;
  discoveredHere: boolean;
}

/** Common surface of a single crawl and a combined multi-profile crawl. */
export interface CrawlRunner {
  status: CrawlStatus;
  run(): Promise<CrawlResult>;
  pause(): void;
  resumeCrawl(): Promise<{ awaitingUser: boolean }>;
  cancel(): void;
  suspend(): void;
  getStats(): CrawlStats;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

class AuthSessionExpiredError extends Error {}

/** GET links that would end the session or destroy data must never be followed with a signed-in profile. */
const SESSION_ENDING = /(^|[\/_.\-=])(log[-_]?out|sign[-_]?out|log[-_]?off|sign[-_]?off|end[-_]?session|deauth\w*)([\/_.\-?&=]|$)/i;
const DESTRUCTIVE = /(^|[\/_.\-=])(delete|destroy|remove|deactivate|unsubscribe|revoke|terminate|purge|wipe|reset[-_]?password|cancel[-_]?(account|subscription|order))([\/_.\-?&=]|$)/i;
export function authenticatedSkipReason(u: URL): string | null {
  const target = decodeURIComponent(u.pathname + u.search).slice(0, 2000);
  if (SESSION_ENDING.test(target)) return "would end the authenticated session";
  if (DESTRUCTIVE.test(target)) return "looks like a state-changing link (not followed while signed in)";
  return null;
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
  sha256?: string;
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

export class Crawler extends EventEmitter implements CrawlRunner {
  status: CrawlStatus = "idle";
  /** Authentication state of this crawler's profile ("not-configured" for public crawls). */
  authStatus: AuthenticationStatus = "not-configured";
  /** Set while the crawl runs on a reusable "Login with Browser" session. */
  private savedProfileUsed = false;
  private savedProfileFailed = false;
  /** The interactive sign-in currently waiting for the user, if any. */
  activeLogin: InteractiveLogin | null = null;
  readonly opts: CrawlOptions;
  readonly startUrl: string;
  error?: string;
  stopReason?: string;

  private allowPrivate: boolean;
  private authProfile?: AuthProfile;
  private authHooks?: AuthHooks;
  private interactiveTimeoutMs: number;
  private packaging: "zip" | "tree";
  private externalRenderer?: Renderer;
  private onDiscovered?: (url: string, depth: number, referrer?: string) => void;
  private hold?: () => boolean;
  private publicAssets?: PublicAssetCache;
  private headedLogin: boolean;
  private profileLabel?: string;
  private api: ApiCollector | null = null;
  private suspended = false;
  private sessionExpired = false;
  private reauth: Promise<void> | null = null;
  private verifiedUrl: string | null = null;
  private injected = new Set<string>();
  /** True once login has finished and the page workers are running. */
  workersStarted = false;
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
    this.authProfile = internal.authProfile;
    this.authHooks = internal.authHooks;
    this.interactiveTimeoutMs = Math.min(60 * 60 * 1000, Math.max(5000, internal.interactiveLoginTimeoutMs ?? 10 * 60 * 1000));
    this.packaging = internal.packaging ?? "zip";
    this.externalRenderer = internal.renderer;
    this.onDiscovered = internal.onDiscovered;
    this.hold = internal.hold;
    this.publicAssets = internal.publicAssets;
    this.headedLogin = !!internal.headedLogin;
    this.profileLabel = internal.authProfile?.name;
    if (this.authProfile) this.authStatus = "waiting-for-credentials";
    this.workDir = internal.workDir;
    this.rawDir = path.join(this.workDir, "raw");
    this.siteDir = path.join(this.workDir, "site");
    this.reportDir = path.join(this.workDir, "report");
    this.zipPath = path.join(this.workDir, "site.zip");
    this.resume = !!internal.resume;
    // Authenticated pages are always rendered in the profile's browser context; "full" additionally keeps scripts.
    this.effectiveMode = this.authProfile ? (this.opts.renderMode === "full" ? "full" : "js") : this.opts.renderMode;
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

  /**
   * Resumes a paused crawl. After a session expiry the profile is reauthenticated first: from a
   * newly saved session, by automated form login, or — for manual/MFA profiles — by handing the
   * login page to the user. In that last case this returns `{ awaitingUser: true }` immediately and
   * the crawl continues by itself once the user has finished signing in.
   */
  async resumeCrawl(): Promise<{ awaitingUser: boolean }> {
    if (this.status !== "paused") return { awaitingUser: false };
    if (this.activeLogin || this.reauth) return { awaitingUser: !!this.activeLogin };
    if (this.sessionExpired && this.authProfile && this.renderer) {
      this.log("AUTH", "Reauthenticating the isolated profile before resuming");
      const renderer = this.renderer;
      const attempt = (async () => {
        await renderer.clearAuthContext();
        await this.establishSession("reauthentication");
      })();
      this.reauth = attempt;
      let onInteractive: (() => void) | undefined;
      const interactive = new Promise<"interactive">((resolve) => {
        onInteractive = () => resolve("interactive");
        this.once("interactive-login", onInteractive);
      });
      let first: "done" | "interactive";
      try {
        first = await Promise.race([attempt.then(() => "done" as const), interactive]);
      } catch {
        this.reauth = null;
        this.setAuthStatus("session-expired");
        this.log("WARN", "Reauthentication failed; crawl remains paused. Check credentials and the authenticated-state selector.");
        throw new Error("Reauthentication failed; the crawl remains paused.");
      } finally {
        if (onInteractive) this.off("interactive-login", onInteractive);
      }
      if (first === "interactive") {
        attempt.then(
          () => this.finishResume(true),
          () => {
            this.reauth = null;
            if (this.cancelled) return;
            this.setAuthStatus("session-expired");
            this.log("WARN", "The sign-in was not completed; the crawl remains paused.");
          },
        );
        return { awaitingUser: true };
      }
      this.finishResume(true);
      return { awaitingUser: false };
    }
    this.finishResume(false);
    return { awaitingUser: false };
  }

  private finishResume(reauthenticated: boolean) {
    this.reauth = null;
    if (this.cancelled || this.status !== "paused") return;
    this.sessionExpired = false;
    this.stopReason = undefined;
    this.paused = false;
    this.segStart = Date.now();
    if (this.authProfile) this.authStatus = "crawling";
    this.setStatus("running");
    this.log("INFO", reauthenticated ? "Reauthenticated session verified; crawl resumed" : "Resumed");
    this.releaseGate();
  }

  cancel() {
    if (this.cancelled || ["completed", "failed", "cancelled", "interrupted"].includes(this.status)) return;
    this.cancelled = true;
    this.ctrl.abort();
    this.log("WARN", "Cancellation requested — finishing in-flight work and packaging what was downloaded");
    void this.activeLogin?.cancel("The crawl was cancelled.");
    this.releaseGate();
  }

  /**
   * Stops without packaging: state is saved so the crawl can be resumed later (worker shutdown,
   * redeploy). `run()` resolves with status "interrupted".
   */
  suspend() {
    if (this.cancelled) return;
    this.suspended = true;
    this.cancelled = true;
    this.ctrl.abort();
    void this.activeLogin?.cancel("The worker is shutting down.");
    this.releaseGate();
  }

  /** Combined discovery: queue a URL that another profile's crawl discovered. */
  inject(url: string, depth: number, referrer?: string) {
    if (this.cancelled || this.status === "completed" || this.status === "failed") return;
    const before = this.discovered.size;
    this.consider(url, depth, referrer ?? "", false, true);
    if (this.discovered.size > before) this.injected.add(url);
  }

  /** True while this crawler still has (or is doing) work. */
  get busy(): boolean {
    return this.queue.length > 0 || this.inflight > 0;
  }

  get siteDirectory() {
    return this.siteDir;
  }

  /** Per-URL outcome for this crawler's profile (used to build the combined access matrix). */
  accessReport(): AccessEntry[] {
    const failures = new Map<string, FailureRecord>();
    for (const f of this.failures) if (f.kind === "page") failures.set(f.url, f);
    const out: AccessEntry[] = [];
    for (const [key, d] of this.discovered) {
      const page = this.pages.get(this.resolveAlias(key));
      const entry: AccessEntry = { url: d.url, key, state: "not-fetched", discoveredHere: !this.injected.has(d.url) };
      if ((d.status === "crawled" || d.status === "duplicate") && page) {
        entry.state = "accessible";
        entry.localPath = page.localPath;
        entry.sha256 = page.sha256;
        entry.httpStatus = page.httpStatus;
      } else if (d.status === "crawled") {
        entry.state = "accessible"; // stored as a file/asset rather than a page
      } else if (d.status === "failed") {
        const f = failures.get(d.url);
        entry.httpStatus = f?.status;
        entry.reason = d.reason;
        entry.state = f?.status === 401 || f?.status === 403 || /access denied|login page/i.test(d.reason ?? "") ? "denied" : "failed";
      } else if (d.status === "skipped") {
        entry.state = "skipped";
        entry.reason = d.reason;
      }
      out.push(entry);
    }
    return out;
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
      apiEndpoints: this.api?.records.size ?? 0,
      ...(this.authProfile || this.authStatus !== "not-configured"
        ? { profiles: [{ profileId: this.profileId, name: this.profileLabel, status: this.authStatus, pagesDiscovered: this.discovered.size, pagesDownloaded: this.counters.crawled, loginSessionId: this.activeLogin?.id }] }
        : {}),
    };
  }

  private profileId = "";

  private setAuthStatus(s: AuthenticationStatus) {
    this.authStatus = s;
    this.emit("auth", s);
    this.emitStats(true);
  }

  private sessionActive(): boolean {
    return !!this.authProfile && !!this.renderer?.hasAuthContext;
  }

  /**
   * Establishes the profile's session, in this order: a saved session supplied by the host, the
   * automated form login, an interactive sign-in driven by the user (manual profiles and MFA).
   */
  private async establishSession(reason: "initial" | "reauthentication"): Promise<void> {
    const profile = this.authProfile;
    const renderer = this.renderer;
    if (!profile || !renderer) throw new Error("Authenticated browser session is unavailable.");
    // A reusable "Login with Browser" profile is tried first: it is what the user explicitly chose.
    if (!this.savedProfileFailed) {
      const reusable = await this.authHooks?.loadSavedProfile?.().catch(() => null);
      if (reusable) {
        try {
          await renderer.restoreSession(reusable.state);
          this.savedProfileUsed = true;
          this.setAuthStatus("authenticated");
          this.log("AUTH", `Restored the saved login profile “${reusable.profileName}”`);
          return;
        } catch {
          this.savedProfileFailed = true;
          await this.authHooks?.onSavedProfileRejected?.("invalid").catch(() => {});
          this.log("WARN", "The saved login profile could not be restored; signing in with this crawl's own settings instead");
        }
      }
    }
    const saved = await this.authHooks?.loadSession?.().catch(() => null);
    if (saved) {
      await renderer.restoreSession(saved);
      this.setAuthStatus("authenticated");
      this.log("AUTH", "Restored the saved browser session for this profile");
      return;
    }
    this.setAuthStatus("logging-in");
    const scopeOrigins = [new URL(this.startNormalized || this.startUrl).origin];
    let login: InteractiveLogin | null = null;
    if (profile.method === "form") {
      if (reason === "initial") this.log("AUTH", "Starting authorized login flow");
      const outcome = await renderer.authenticate(profile, this.opts.requestTimeoutMs, { interactiveTimeoutMs: this.interactiveTimeoutMs, scopeOrigins });
      if (outcome.status === "interactive") login = outcome.login;
      else if (this.authHooks?.saveSession) {
        // Lets an interrupted job continue without submitting the credentials again.
        const state = await renderer.exportSession().catch(() => null);
        if (state) await this.authHooks.saveSession(state).catch(() => {});
      }
    } else {
      login = await renderer.beginInteractiveLogin(profile, {
        timeoutMs: this.interactiveTimeoutMs,
        navigationTimeoutMs: this.opts.requestTimeoutMs,
        scopeOrigins,
        reason: reason === "initial" ? "manual-login" : "reauthentication",
      });
    }
    if (login) {
      const wasRunning = this.status === "running";
      if (wasRunning) {
        // Waiting for a person does not count against the crawl's time limit.
        this.activeAccum += Date.now() - this.segStart;
        this.stopReason = login.reason === "mfa" ? "Waiting for the user to complete the verification step (MFA)." : "Waiting for the user to sign in manually.";
        this.status = "paused";
        this.emit("status", "paused");
      }
      this.activeLogin = login;
      this.setAuthStatus("awaiting-manual-verification");
      this.log("AUTH", login.reason === "mfa" ? "The site asked for an additional verification step; waiting for the user to complete it" : "Waiting for the user to sign in in the isolated browser");
      this.authHooks?.onInteractiveLogin?.(login);
      this.emit("interactive-login", login);
      try {
        await login.wait();
      } finally {
        this.activeLogin = null;
      }
      if (login.sessionState) {
        try {
          await this.authHooks?.saveSession?.(login.sessionState);
        } catch {
          this.log("WARN", "The authenticated session could not be saved for reuse; it stays valid for this crawl only");
        }
      }
      if (wasRunning && !this.cancelled) {
        this.stopReason = undefined;
        this.segStart = Date.now();
        this.status = "running";
        this.emit("status", "running");
      }
    }
    this.setAuthStatus("authenticated");
    this.log("AUTH", "Login state verified");
  }

  /**
   * After a 401/403 or a bounce to the login page: decides whether the *session* is gone or only this
   * page is off limits for the profile, by re-rendering a page that the session could open before.
   */
  private sessionStillValid(): Promise<boolean> {
    // Concurrent workers share one probe; every refusal is checked against the live session.
    if (!this.probe) this.probe = this.probeSession().finally(() => (this.probe = null));
    return this.probe;
  }

  private probe: Promise<boolean> | null = null;

  private async probeSession(): Promise<boolean> {
    if (!this.verifiedUrl || !this.renderer || !this.authProfile) return false;
    try {
      const login = new URL(this.authProfile.loginUrl);
      const r = await this.renderer.render(this.verifiedUrl, { mode: "js", timeoutMs: this.opts.requestTimeoutMs, signal: this.ctrl.signal });
      const final = new URL(r.finalUrl);
      return r.status >= 200 && r.status < 300 && !(final.origin === login.origin && final.pathname === login.pathname);
    } catch {
      return false;
    }
  }

  // ---------- internals ----------

  private wipeAuthProfile() {
    if (this.authProfile) {
      this.authProfile.username = "";
      this.authProfile.password = "";
      this.authProfile = undefined;
    }
  }

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

  private async fetchUrl(url: string, maxBytes: number, validate?: (u: URL) => void, withSession = false, headers?: Record<string, string>): Promise<HttpResult & { attempts: number }> {
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
        headers,
        // The profile's cookies are looked up per hop in the browser's own cookie jar, so they only
        // ever reach hosts/paths they belong to (never a cross-site redirect target).
        headersFor:
          withSession && this.sessionActive()
            ? async (hop): Promise<Record<string, string>> => {
                const cookie = await this.renderer!.cookieHeader(hop.href);
                return cookie ? { cookie } : {};
              }
            : undefined,
        onRetry: (attempt, reason, wait) => this.log("RETRY", `${url} — ${reason}; retry ${attempt}/${this.opts.retries} in ${wait}ms`),
      });
    } finally {
      this.sem.release();
    }
  }

  /**
   * Asset download. With a signed-in profile the request carries that profile's cookies. In combined
   * discovery the asset is first requested anonymously through a cache shared by all profiles: if it
   * is public it is downloaded exactly once; only otherwise is it fetched with this profile's session.
   */
  private async fetchAsset(url: string, maxBytes: number): Promise<HttpResult & { attempts: number; fetchedWith?: "session" | "anonymous" }> {
    if (!this.sessionActive()) return this.fetchUrl(url, maxBytes);
    if (this.publicAssets) {
      const pub = await this.publicAssets.get(url, maxBytes, () => this.fetchUrl(url, maxBytes), this.authProfile?.loginUrl);
      if (pub) return { ...pub, fetchedWith: "anonymous" };
    }
    const res = await this.fetchUrl(url, maxBytes, undefined, true);
    return { ...res, fetchedWith: "session" };
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
  private consider(raw: string, depth: number, referrer: string, force = false, fromSibling = false) {
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
      if (!fromSibling) {
        // This profile found the link on its own pages too (provenance for combined discovery).
        this.injected.delete(known.url);
        this.onDiscovered?.(known.url, known.depth, referrer || undefined);
      }
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
      if (this.authProfile) {
        const risky = authenticatedSkipReason(u);
        if (risky) return reject(risky);
      }
    }
    if (this.enqueued >= this.opts.maxPages) return reject(`max pages (${this.opts.maxPages}) reached`);
    this.enqueued++;
    this.discovered.set(key, { url: norm, status: "queued", depth, referrer });
    this.queue.push({ url: norm, key, depth, referrer });
    this.log("FOUND", norm);
    if (!fromSibling) this.onDiscovered?.(norm, depth, referrer || undefined);
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
        fetch: (url, maxBytes) => this.fetchAsset(url, maxBytes),
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
      this.profileId = this.authProfile?.id ?? "";
      this.api = new ApiCollector({
        mode: this.opts.apiDiscovery,
        keepBodies: this.opts.apiDiscovery === "archive" || this.opts.apiFollowPagination,
        maxResponses: this.opts.apiMaxResponses,
        maxResponseBytes: this.opts.apiMaxResponseBytes,
        siteDir: this.siteDir,
        registry: this.registry,
        primaryHost: () => this.scope.baseHost,
        primaryPort: () => this.scope.basePort,
        inScope: (x) => this.scope.isSameSite(x),
        remainingBytes: () => this.remainingBytes(),
        addBytes: (n) => this.addBytes(n),
        log: (tag, msg) => this.log(tag, msg),
        profile: this.authProfile?.name,
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

      if (this.authProfile || this.opts.renderMode !== "fast" || this.opts.visualCompare) {
        this.renderer = this.externalRenderer ?? (await Renderer.create(this.allowPrivate, { headed: this.headedLogin && !!this.authProfile }));
        if (!this.renderer) {
          if (this.authProfile) throw new Error(`Authenticated crawling requires Chromium, but it could not be launched (${Renderer.lastError}).`);
          if (this.opts.renderMode !== "fast") {
            this.effectiveMode = "fast";
            this.log("WARN", `Chromium unavailable (${Renderer.lastError}); falling back to fast HTML mode`);
            this.unsupported.notes.push(`JavaScript rendering was requested but Chromium could not be launched (${Renderer.lastError}). Pages were fetched as static HTML.`);
          }
          if (this.opts.visualCompare) this.visualNote = `Visual comparison skipped: Chromium unavailable (${Renderer.lastError}).`;
        }
        if (this.renderer) {
          // GraphQL read access is opt-in per endpoint and never extends beyond the crawl scope.
          const allowed: string[] = [];
          for (const raw of this.opts.graphqlEndpoints) {
            try {
              const g = new URL(raw, sn);
              if (/^https?:$/.test(g.protocol) && this.scope.isSameSite(g)) allowed.push(g.origin + g.pathname);
              else this.log("WARN", `GraphQL endpoint ${raw} is outside the crawl scope and was ignored`);
            } catch {
              this.log("WARN", `GraphQL endpoint ${raw} is not a valid URL and was ignored`);
            }
          }
          this.renderer.setGraphqlEndpoints(allowed);
          if (allowed.length) this.log("API", `Read-only GraphQL queries are authorised for: ${allowed.join(", ")}`);
        }
        if (this.renderer && this.authProfile) {
          try {
            await this.establishSession("initial");
          } catch (e) {
            if (this.suspended) return await this.suspendResult();
            if (this.cancelled) return await this.finalize();
            this.setAuthStatus("authentication-failed");
            throw e;
          }
          this.authStatus = "crawling";
          this.log("AUTH", "Authenticated crawl starting");
        }
      }

      if (this.opts.useSitemap && !this.resume) await this.discoverSitemaps(start);

      this.workersStarted = true;
      const workers = Array.from({ length: this.opts.concurrency }, () => this.worker());
      await Promise.all(workers);
      if (this.suspended) return await this.suspendResult();
      return await this.finalize();
    } catch (e) {
      const err = e as Error;
      this.error = err instanceof SsrfError ? `Blocked by security policy: ${err.message}` : err.message;
      this.log("FAILED", this.error);
      await this.renderer?.clearAuthContext();
      await this.renderer?.close();
      this.wipeAuthProfile();
      if (this.status === "running" || this.status === "paused") {
        this.activeAccum = this.activeMs();
        this.status = "failed";
        this.emit("status", "failed");
      }
      this.emitStats(true);
      return { status: "failed", error: this.error, stats: this.getStats() };
    }
  }

  /** Saves state and releases the browser without packaging (see suspend()). */
  private async suspendResult(): Promise<CrawlResult> {
    this.activeAccum = this.activeMs();
    await this.saveState();
    await this.renderer?.clearAuthContext();
    await this.renderer?.close();
    this.wipeAuthProfile();
    this.status = "interrupted";
    this.emit("status", "interrupted");
    this.emitStats(true);
    return { status: "interrupted", stats: this.getStats() };
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
        if (this.inflight === 0 && !this.hold?.()) break;
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
        if (e instanceof AuthSessionExpiredError) {
          const d = this.discovered.get(item.key);
          if (d) d.status = "queued";
          this.queue.unshift(item);
          if (!this.sessionExpired && !this.cancelled) {
            this.sessionExpired = true;
            this.verifiedUrl = null;
            if (this.status === "running") this.activeAccum += Date.now() - this.segStart;
            this.paused = true;
            this.stopReason = "Authenticated session expired; reauthenticate to resume this profile.";
            await this.saveState();
            this.log("WARN", this.stopReason);
            // The rejected session must not be restored again.
            await this.authHooks?.clearSession?.("expired").catch(() => {});
            if (this.savedProfileUsed) {
              // A rejected reusable session is never offered again: reauthentication uses the
              // profile's own credentials (or asks the user), and the owner is told to renew it.
              this.savedProfileFailed = true;
              this.savedProfileUsed = false;
              await this.authHooks?.onSavedProfileRejected?.("expired").catch(() => {});
            }
            this.authStatus = "session-expired";
            this.emit("auth", "session-expired");
            this.setStatus("paused");
          }
        } else this.pageFailed(item, e as Error);
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
    let authenticatedRender: Awaited<ReturnType<Renderer["render"]>> | undefined;
    let res: HttpResult & { attempts: number };
    if (this.authProfile) {
      if (!this.renderer) throw new Error("Authenticated browser session is unavailable.");
      const loginOrigin = new URL(this.authProfile.loginUrl).origin;
      authenticatedRender = await this.renderer.render(url, { mode: this.effectiveMode === "full" ? "full" : "js", timeoutMs: this.opts.requestTimeoutMs, signal: this.ctrl.signal, api: this.apiCapture(), validateNavigation: (target) => {
        try { const next = new URL(target); return this.scope.isSameSite(next) || next.origin === loginOrigin; } catch { return false; }
      } });
      const final = new URL(authenticatedRender.finalUrl);
      const loginUrl = new URL(this.authProfile.loginUrl);
      const bouncedToLogin = final.pathname === loginUrl.pathname && final.origin === loginUrl.origin;
      const refused = authenticatedRender.status === 401 || authenticatedRender.status === 403 || (authenticatedRender.status >= 300 && authenticatedRender.status < 400);
      if (bouncedToLogin || refused) {
        // Either the session is gone, or this page is simply off limits for this profile.
        if (!(await this.sessionStillValid())) throw new AuthSessionExpiredError(bouncedToLogin ? "The session redirected back to the login page." : "The authenticated page returned an access-denied or redirect response.");
        const denied = new Error(bouncedToLogin ? "access denied for this profile (redirected to the login page while the session is still valid)" : `access denied for this profile (HTTP ${authenticatedRender.status})`) as Error & { attempts?: number };
        denied.attempts = 1;
        return this.pageFailed(item, denied, bouncedToLogin ? 403 : authenticatedRender.status);
      }
      if (!this.scope.isSameSite(final)) throw new Error("redirect leaves the authorised domain scope");
      if (authenticatedRender.status >= 200 && authenticatedRender.status < 300) {
        if (!this.verifiedUrl) this.verifiedUrl = url;
      }
      res = { url: authenticatedRender.finalUrl, status: authenticatedRender.status, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(authenticatedRender.html), redirects: [], contentType: "text/html; charset=utf-8", attempts: 1 };
    } else {
      res = await this.fetchUrl(url, Math.min(this.opts.maxFileSize, remaining), (next) => {
        if (depth > 0 && !this.scope.isSameSite(next)) throw new Error("redirect leaves the authorised domain scope");
      });
    }
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
    if (this.authProfile && res.body.byteLength > Math.min(this.opts.maxFileSize, this.remainingBytes())) throw new Error("authenticated rendered page exceeded the configured page-size limit");
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
    let renderedWith = this.authProfile ? `authenticated-${this.effectiveMode === "full" ? "full" : "js"}` : "fast";
    let networkAssets: string[] = [];
    let routes: string[] = [];
    let apiObservations: ApiObservation[] = [];
    if (authenticatedRender) {
      networkAssets = authenticatedRender.networkAssets;
      routes = authenticatedRender.routes;
      authenticatedRender.apiCalls.forEach((a) => this.unsupported.apiCalls.add(redactUrl(a)));
      apiObservations = authenticatedRender.api;
    } else if (this.renderer && this.effectiveMode !== "fast") {
      try {
        const r = await this.renderer.render(res.url, { mode: this.effectiveMode, timeoutMs: this.opts.requestTimeoutMs, signal: this.ctrl.signal, api: this.apiCapture() });
        html = r.html;
        networkAssets = r.networkAssets;
        routes = r.routes;
        r.apiCalls.forEach((a) => this.unsupported.apiCalls.add(redactUrl(a)));
        apiObservations = r.api;
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
      sha256: ch,
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
    if (apiObservations.length) await this.handleApi(apiObservations, finalNorm);
    const dFinal = this.discovered.get(finalKey) ?? d;
    dFinal.status = "crawled";
    if (finalKey !== key) d.status = "duplicate";
    this.counters.crawled++;
    this.log("COMPLETE", finalNorm);
  }

  // ---------- API discovery ----------

  private apiCapture() {
    const api = this.api;
    if (!api || !api.enabled) return undefined;
    return { wantsBody: (u: string, m: string, ct: string, len: number | undefined) => api.wantsBody(u, m, ct, len), maxBodyBytes: this.opts.apiMaxResponseBytes };
  }

  private async handleApi(observations: ApiObservation[], pageUrl: string) {
    const api = this.api;
    if (!api || !api.enabled) return;
    for (const o of observations) {
      if (this.cancelled) return;
      const r = await api.observe(o, pageUrl);
      if (!r || !r.isNew || r.json === undefined) continue;
      await this.apiAssets(r.json, o.url);
      if (this.opts.apiFollowPagination && o.method === "GET") await this.followPagination(o.url, r.record, r.json, o.linkHeader, pageUrl);
    }
  }

  /** "Relevant asset requests": static files (images, fonts, media) referenced from archived JSON. */
  private async apiAssets(json: unknown, base: string) {
    if (!this.opts.downloadAssets || this.opts.apiDiscovery !== "archive") return;
    for (const a of extractAssetUrlsFromJson(json, base, 100)) {
      if (this.cancelled) return;
      await this.assets.download(a, base, 0);
    }
  }

  /**
   * Follows explicit `next` links of a JSON endpoint. Only GET, only the endpoint's own origin and
   * the crawl scope, bounded by apiMaxPaginationPages, honouring robots.txt and the request throttle.
   */
  private async followPagination(startUrl: string, first: ApiRecord, firstJson: unknown, firstLink: string | undefined, pageUrl: string) {
    const api = this.api!;
    let cur = startUrl;
    let prev = first;
    let next = detectNextPage(cur, firstJson, firstLink);
    for (let i = 1; next && i < this.opts.apiMaxPaginationPages && !this.cancelled; i++) {
      const target = new URL(next);
      if (!this.scope.isSameSite(target)) break;
      if (api.records.has(`GET ${redactUrl(next)}`)) break;
      if (this.opts.respectRobots) {
        const robots = await this.robotsFor(next);
        if (robots && !robots.allowed(target.pathname + target.search)) break;
      }
      let res: HttpResult & { attempts: number };
      try {
        const origin = target.origin;
        res = await this.fetchUrl(
          next,
          this.opts.apiMaxResponseBytes,
          (u) => {
            if (u.origin !== origin) throw new Error("pagination redirect leaves the endpoint origin");
          },
          true,
          { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
        );
      } catch {
        break;
      }
      const link = res.headers["link"];
      const obs: ApiObservation = { url: next, method: "GET", resourceType: "pagination", status: res.status, contentType: res.contentType, bytes: res.body.length, body: res.body, linkHeader: Array.isArray(link) ? link.join(", ") : link };
      const r = await api.observe(obs, pageUrl);
      prev.pagination = { ...prev.pagination, next: redactUrl(next) };
      if (!r || !r.isNew) break;
      r.record.pagination = { followedFrom: redactUrl(cur) };
      if (r.json === undefined) break;
      await this.apiAssets(r.json, next);
      prev = r.record;
      cur = next;
      next = detectNextPage(cur, r.json, obs.linkHeader);
    }
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
    this.segStart = Date.now();
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
      await this.renderer?.clearAuthContext();
      await this.renderer?.close();
      this.wipeAuthProfile();
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
    await this.renderer?.clearAuthContext();
    await this.renderer?.close();
    this.wipeAuthProfile();

    await this.writeAllReports(wasCancelled ? "cancelled" : "completed");
    if (this.packaging === "tree") {
      // Combined discovery packages several profile trees itself.
      await fs.promises.rm(this.rawDir, { recursive: true, force: true });
      await fs.promises.rm(path.join(this.workDir, "state.json"), { force: true });
      this.status = wasCancelled ? "cancelled" : "completed";
      if (this.authStatus !== "not-configured") this.authStatus = "completed";
      this.emit("status", this.status);
      this.emitStats(true);
      return { status: this.status, reportDir: this.reportDir, siteDir: this.siteDir, stats: this.getStats() };
    }
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
    if (this.authStatus !== "not-configured") this.authStatus = "completed";
    this.emit("status", this.status);
    this.emitStats(true);
    return { status: this.status, zipPath: this.zipPath, zipEntries: zip.entries, reportDir: this.reportDir, stats: this.getStats() };
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
    const banner = (url: string) => `Archived from ${url} on ${new Date().toISOString()} by Universal Clone 3.1`;

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
        { stripScripts: page.renderedWith === "js" || page.renderedWith === "authenticated-js", banner: banner(page.finalUrl) },
      );
      const full = safeJoin(this.siteDir, page.localPath);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, out);
    }
    if (this.pages.size && [...this.pages.values()].some((p) => p.renderedWith === "js" || p.renderedWith === "authenticated-js")) {
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
    const authOutcome = this.authStatus === "crawling" && status === "completed" ? "completed" : this.authStatus;
    const live = this.getStats();
    const finalStats = { ...live, status: status as typeof live.status, currentUrls: [], ...(live.profiles ? { profiles: live.profiles.map((p) => ({ ...p, status: authOutcome, loginSessionId: undefined })) } : {}) };
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
      // The reports are written just before the status flips, so they carry the outcome explicitly.
      stats: finalStats,
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
      api: { mode: this.api?.enabled ? this.opts.apiDiscovery : "off", graphqlEndpoints: this.opts.graphqlEndpoints, followPagination: this.opts.apiFollowPagination, records: this.api?.list() ?? [] },
      authentication: this.profileId ? { profileId: this.profileId, profileName: this.profileLabel ?? "", status: authOutcome } : undefined,
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
        api: this.api?.list() ?? [],
        injected: [...this.injected],
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
      if (Array.isArray(s.api)) this.api?.restore(s.api);
      if (Array.isArray(s.injected)) this.injected = new Set(s.injected);
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
