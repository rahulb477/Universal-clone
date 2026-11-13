import crypto from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { loginProfileCommands, loginSessions, targetLoginProfiles } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crawler/auth";
import type { LoginInput } from "@/lib/crawler/interactive-login";
import { LOGIN_BROWSER_IDLE_GRACE_MS } from "@/lib/crawler/saved-login";
import { redactUrl } from "@/lib/crawler/api-discovery";
import { Renderer } from "@/lib/crawler/renderer";
import { allowPrivateNetworks, limits } from "@/lib/server/config";
import { invalidateSavedSession, openSavedSessionForWorker, saveCapturedSession, touchSavedSession } from "@/lib/server/login-profiles";
import { BrowserLogin } from "./browser-login";

/**
 * Worker-side host for the "Login with Browser" windows of reusable profiles.
 *
 * The web tier only writes rows: a `login_sessions` row (state, encrypted screenshots) and
 * `login_profile_commands` entries (open / input / confirm / cancel). This manager turns those into
 * a real isolated Chromium context, publishes encrypted frames for the owner, and — when the user
 * presses "Use This Login" — validates the session and stores it for later crawls.
 *
 * The browser process is shared (one per worker, like the crawler's), every window gets its own
 * context, and a window can only navigate inside the profile's own site.
 */

interface Entry {
  login: BrowserLogin;
  ownerId: string;
  profileId: string;
  sid: string;
  frameTimer: NodeJS.Timeout | null;
  lastHash: string;
  busy: boolean;
}

export interface LoginBrowserManagerOptions {
  log?: (msg: string) => void;
  /** How long an untouched window stays open (default 90 s). */
  idleGraceMs?: number;
}

export class LoginBrowserManager {
  private entries = new Map<string, Entry>();
  private renderer: Renderer | null = null;
  private rendererError = "";
  private processing = false;
  /** Last time the (write-only) stale-row sweep ran. */
  private lastSweep = 0;
  private log: (msg: string) => void;
  private idleGraceMs: number;

  constructor(opts: LoginBrowserManagerOptions = {}) {
    this.log = opts.log ?? ((m) => console.log(`[login-browser] ${m}`));
    this.idleGraceMs = opts.idleGraceMs ?? LOGIN_BROWSER_IDLE_GRACE_MS;
  }

  get open(): number {
    return this.entries.size;
  }

  private async getRenderer(): Promise<Renderer | null> {
    if (this.renderer) return this.renderer;
    const r = await Renderer.create(allowPrivateNetworks());
    if (!r) {
      this.rendererError = Renderer.lastError || "Chromium is not available on this worker.";
      return null;
    }
    this.renderer = r;
    return r;
  }

  /** Called from the worker's polling loop. Never throws. */
  async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.handleCommands();
      await this.reap();
    } catch (e) {
      this.log(`tick failed: ${(e as Error).message}`);
    } finally {
      this.processing = false;
    }
  }

  private async handleCommands(): Promise<void> {
    const cmds = await db
      .select()
      .from(loginProfileCommands)
      .where(isNull(loginProfileCommands.processedAt))
      .orderBy(loginProfileCommands.id)
      .limit(50);
    for (const c of cmds) {
      let result = "ok";
      try {
        result = (await this.execute(c.sid, c.savedProfileId, c.ownerId, c.type, c.payload)) ?? "ok";
      } catch (e) {
        result = `error: ${(e as Error).message.slice(0, 200)}`;
      }
      // A payload can hold what the user typed (possibly a password): it is dropped immediately.
      await db.update(loginProfileCommands).set({ processedAt: new Date(), payload: null, result }).where(eq(loginProfileCommands.id, c.id));
    }
  }

  private async execute(sid: string, profileId: string, ownerId: string, type: string, payload: string | null): Promise<string | void> {
    switch (type) {
      case "open":
        return this.openWindow(sid, profileId, ownerId, payload);
      case "input": {
        const entry = this.entries.get(sid);
        if (!entry) return "no such window";
        const { event } = JSON.parse(decryptSecret(payload ?? "", `cmd:login-browser:${sid}`)) as { sid: string; event: LoginInput };
        await entry.login.input(event);
        entry.lastHash = "";
        return;
      }
      case "confirm": {
        const entry = this.entries.get(sid);
        if (!entry) return "no such window";
        const r = await entry.login.confirm();
        if (!r.ok) {
          await db
            .update(loginSessions)
            .set({ message: r.message ?? "Sign-in is not complete yet." })
            .where(and(eq(loginSessions.id, sid), eq(loginSessions.status, "awaiting-user")));
          return "not authenticated yet";
        }
        return "saved";
      }
      case "cancel": {
        const entry = this.entries.get(sid);
        if (!entry) return "no such window";
        await entry.login.cancel("The sign-in was cancelled.");
        return;
      }
      default:
        return "unknown command";
    }
  }

  private async openWindow(sid: string, profileId: string, ownerId: string, payload: string | null): Promise<string> {
    if (this.entries.size >= 5) return "too many open windows on this worker";
    const rows = await db.select().from(targetLoginProfiles).where(and(eq(targetLoginProfiles.id, profileId), eq(targetLoginProfiles.ownerId, ownerId))).limit(1);
    const profile = rows[0];
    if (!profile) {
      await this.finishRow(sid, "failed", "This login profile no longer exists.");
      return "profile missing";
    }
    const parsed = payload ? (JSON.parse(payload) as { entryUrl?: string; authenticatedSelector?: string | null }) : {};
    const entryUrl = parsed.entryUrl || profile.loginUrl || profile.startUrl;
    const renderer = await this.getRenderer();
    if (!renderer) {
      await this.finishRow(sid, "failed", `The isolated browser is not available on this worker: ${this.rendererError}`);
      return "no browser";
    }
    const login = new BrowserLogin({
      profileId,
      profileName: profile.name,
      scope: { targetHost: profile.targetHost, targetOrigin: profile.targetOrigin, matchSubdomains: profile.matchSubdomains },
      entryUrl,
      authenticatedSelector: parsed.authenticatedSelector ?? profile.authenticatedSelector,
      reason: "manual-login",
      timeoutMs: limits.browserLoginMinutes * 60 * 1000,
      renderer,
      onAuthenticated: async (state) => {
        await saveCapturedSession(profileId, ownerId, state);
        this.log(`saved a login session for profile ${profileId}`);
      },
      onAbandoned: async (reason) => {
        // The window row is finished by the status listener; nothing secret is kept.
        this.log(`window ${sid} ended: ${reason.slice(0, 120)}`);
      },
    });
    try {
      await login.open();
    } catch (e) {
      await this.finishRow(sid, "failed", `The sign-in page could not be opened: ${(e as Error).message.split("\n")[0]}`);
      return "open failed";
    }
    const entry: Entry = { login, ownerId, profileId, sid, frameTimer: null, lastHash: "", busy: false };
    this.entries.set(sid, entry);
    entry.frameTimer = setInterval(() => void this.capture(entry), 700);
    entry.frameTimer.unref?.();
    login.onStatus((v) => {
      if (v.status === "awaiting-user") return;
      void this.close(entry, v.status, v.message);
    });
    void this.capture(entry);
    this.log(`opened window ${sid} for ${profile.targetHost}`);
    return "ok";
  }

  private async capture(entry: Entry) {
    if (entry.busy || entry.login.status !== "awaiting-user") return;
    entry.busy = true;
    try {
      const jpeg = await entry.login.frame();
      if (!jpeg) return;
      const hash = crypto.createHash("sha1").update(jpeg).digest("hex");
      if (hash === entry.lastHash) return;
      entry.lastHash = hash;
      const view = entry.login.view();
      // A picture of a sign-in page is sensitive: encrypted at rest, bound to this window, deleted
      // as soon as the window ends.
      await db
        .update(loginSessions)
        .set({
          frame: encryptSecret(jpeg, `login-frame:${entry.sid}`),
          frameSeq: sql`${loginSessions.frameSeq} + 1`,
          pageUrl: view.url ? redactUrl(view.url) : null,
          // The reused page_title column carries the origins the window refused to visit.
          pageTitle: JSON.stringify(view.blockedOrigins.slice(0, 10)),
        })
        .where(and(eq(loginSessions.id, entry.sid), eq(loginSessions.status, "awaiting-user")))
        .returning({ id: loginSessions.id });;
    } catch {
      /* next tick */
    } finally {
      entry.busy = false;
    }
  }

  private async close(entry: Entry, status: string, message: string | null) {
    if (entry.frameTimer) clearInterval(entry.frameTimer);
    entry.frameTimer = null;
    this.entries.delete(entry.sid);
    await this.finishRow(entry.sid, status === "authenticated" ? "authenticated" : status, status === "authenticated" ? null : message);
    await entry.login.cancel("closed").catch(() => {});
  }

  private async finishRow(sid: string, status: string, message: string | null) {
    await db
      .update(loginSessions)
      .set({ status, message, frame: null, finishedAt: new Date() })
      .where(and(eq(loginSessions.id, sid), inArray(loginSessions.status, ["awaiting-user"])))
      .catch(() => {});
  }

  /** Closes windows the user abandoned, and anything older than its expiry. */
  private async reap() {
    // The stale-row sweep is a write; it does not need to run on every poll.
    if (Date.now() - this.lastSweep > 5000) {
      this.lastSweep = Date.now();
      await this.sweepStaleRows();
    }
    for (const entry of [...this.entries.values()]) {
      const expired = Date.now() > entry.login.expiresAt;
      const idle = entry.login.idleFor(this.idleGraceMs);
      if (!expired && !idle) continue;
      const message = expired ? "The sign-in window timed out." : "The sign-in window closed after a period of inactivity. Choose “Login with Browser” again.";
      await entry.login.cancel(message).catch(() => {});
      if (entry.frameTimer) clearInterval(entry.frameTimer);
      this.entries.delete(entry.sid);
      await this.finishRow(entry.sid, expired ? "expired" : "cancelled", message);
      this.log(`reaped window ${entry.sid}: ${message}`);
    }
  }

  /** Rows whose window is gone (worker restart, deleted profile) must not stay “awaiting-user”. */
  private async sweepStaleRows() {
    const stale = await db
      .update(loginSessions)
      .set({ status: "expired", message: "The sign-in window is no longer open on the worker.", frame: null, finishedAt: new Date() })
      .where(and(eq(loginSessions.scope, "login-browser"), eq(loginSessions.status, "awaiting-user"), lt(loginSessions.expiresAt, new Date())))
      .returning({ id: loginSessions.id });
    for (const s of stale) {
      const entry = this.entries.get(s.id);
      if (entry) await entry.login.cancel("expired").catch(() => {});
    }
  }

  /** Validates a stored session for a job that is about to use it (never returns raw cookies). */
  static async loadForJob(profileId: string, ownerId: string) {
    return openSavedSessionForWorker(profileId, ownerId);
  }

  static async markRejected(profileId: string, reason: "expired" | "invalid") {
    await invalidateSavedSession(profileId, reason === "expired" ? "expired" : "rejected");
  }

  static async markValidated(profileId: string) {
    await touchSavedSession(profileId);
  }

  async stop(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (entry.frameTimer) clearInterval(entry.frameTimer);
      await entry.login.cancel("The worker stopped.").catch(() => {});
      await this.finishRow(entry.sid, "cancelled", "The worker stopped; open the sign-in window again.");
    }
    this.entries.clear();
    await this.renderer?.close().catch(() => {});
    this.renderer = null;
  }
}
