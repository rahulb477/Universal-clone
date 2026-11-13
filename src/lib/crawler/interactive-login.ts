import crypto from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import type { AuthProfile } from "./auth";

/**
 * A human-driven sign-in inside an isolated browser context.
 *
 * The user sees screenshots of the page and sends pointer/keyboard input; the crawler itself never
 * answers a CAPTCHA, an MFA prompt or any other challenge. The session ends when
 *   - the profile's authenticated-state selector becomes visible (detected automatically), or
 *   - the user confirms completion and the page is demonstrably no longer the login form, or
 *   - it is cancelled / times out, in which case the context is destroyed.
 */

export type LoginInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number }
  | { type: "back" }
  | { type: "reload" };

export type InteractiveStatus = "awaiting-user" | "authenticated" | "failed" | "cancelled" | "expired";
export type InteractiveReason = "manual-login" | "mfa" | "reauthentication";

/** Serialised Playwright storage state (cookies + localStorage). Treated as a secret. */
export type SessionState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const LOGIN_VIEWPORT = { width: 1280, height: 800 };
const KEY_RE = /^((Shift|Control|Alt|Meta)\+){0,2}(Enter|Tab|Backspace|Delete|Escape|Space|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|[a-zA-Z0-9])$/;
const MAX_TEXT = 500;

export class LoginInputError extends Error {}

/** Validates untrusted input events from the API boundary. */
export function parseLoginInput(raw: unknown): LoginInput {
  if (!raw || typeof raw !== "object") throw new LoginInputError("Invalid input event.");
  const e = raw as Record<string, unknown>;
  const finite = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  switch (e.type) {
    case "click":
      if (!finite(e.x, 0, LOGIN_VIEWPORT.width) || !finite(e.y, 0, LOGIN_VIEWPORT.height)) throw new LoginInputError("Click is outside the page.");
      return { type: "click", x: Math.round(e.x as number), y: Math.round(e.y as number) };
    case "type":
      if (typeof e.text !== "string" || e.text.length === 0 || e.text.length > MAX_TEXT) throw new LoginInputError(`Text must be 1–${MAX_TEXT} characters.`);
      return { type: "type", text: e.text };
    case "key":
      if (typeof e.key !== "string" || !KEY_RE.test(e.key)) throw new LoginInputError("Unsupported key.");
      return { type: "key", key: e.key };
    case "scroll":
      if (!finite(e.dy, -5000, 5000)) throw new LoginInputError("Invalid scroll distance.");
      return { type: "scroll", dy: Math.round(e.dy as number) };
    case "back":
      return { type: "back" };
    case "reload":
      return { type: "reload" };
    default:
      throw new LoginInputError("Unknown input event type.");
  }
}

export interface InteractiveLoginInit {
  ctx: BrowserContext;
  page: Page;
  profile: AuthProfile;
  reason: InteractiveReason;
  timeoutMs: number;
  /** Origins blocked by the navigation guard during this session (for user feedback). */
  blockedOrigins: () => string[];
  /** Called once when authentication is confirmed; the context becomes the profile's crawl context. */
  onAuthenticated: (ctx: BrowserContext) => void | Promise<void>;
  /** Called when the session ends without authentication. */
  onAbandoned: (ctx: BrowserContext) => void | Promise<void>;
}

export class InteractiveLogin {
  readonly id = crypto.randomBytes(8).toString("hex");
  readonly profileId: string;
  readonly reason: InteractiveReason;
  readonly startedAt = Date.now();
  readonly expiresAt: number;
  status: InteractiveStatus = "awaiting-user";
  error?: string;
  /** Available once authenticated. Must only ever be stored encrypted. */
  sessionState?: SessionState;

  private page: Page;
  private chain: Promise<unknown> = Promise.resolve();
  private poll: NodeJS.Timeout | null = null;
  private expiry: NodeJS.Timeout | null = null;
  private settle!: { resolve: () => void; reject: (e: Error) => void };
  private readonly done: Promise<void>;
  private listeners = new Set<(s: InteractiveStatus) => void>();
  private checking = false;

  constructor(private o: InteractiveLoginInit) {
    this.profileId = o.profile.id;
    this.reason = o.reason;
    this.page = o.page;
    this.expiresAt = this.startedAt + o.timeoutMs;
    this.done = new Promise<void>((resolve, reject) => (this.settle = { resolve, reject }));
    this.done.catch(() => {});
    // Sign-in providers sometimes open a new tab/popup; follow the most recent page.
    o.ctx.on("page", (p) => {
      this.page = p;
      p.on("close", () => {
        const open = o.ctx.pages().filter((x) => !x.isClosed());
        if (open.length) this.page = open[open.length - 1];
      });
    });
    this.poll = setInterval(() => void this.check(), 700);
    this.poll.unref?.();
    this.expiry = setTimeout(() => void this.end("expired", "The sign-in window timed out before authentication was completed."), o.timeoutMs);
    this.expiry.unref?.();
  }

  /** Resolves when the user has authenticated; rejects when the session is cancelled, fails or expires. */
  wait(): Promise<void> {
    return this.done;
  }

  onStatus(fn: (s: InteractiveStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Current page location without query string or fragment (those can carry one-time codes). */
  info(): { url: string; title: string; blockedOrigins: string[] } {
    let url = "";
    try {
      const u = new URL(this.page.url());
      url = u.origin + u.pathname;
    } catch {
      /* about:blank */
    }
    return { url, title: "", blockedOrigins: this.o.blockedOrigins() };
  }

  /** JPEG screenshot of the visible viewport. Password inputs are masked by the browser itself. */
  async frame(): Promise<Buffer | null> {
    if (this.status !== "awaiting-user") return null;
    return this.run(async () => {
      try {
        return await this.page.screenshot({ type: "jpeg", quality: 60, timeout: 5000, animations: "disabled", caret: "initial" });
      } catch {
        return null;
      }
    });
  }

  async input(ev: LoginInput): Promise<void> {
    if (this.status !== "awaiting-user") throw new LoginInputError("This sign-in session is no longer active.");
    await this.run(async () => {
      const p = this.page;
      switch (ev.type) {
        case "click":
          await p.mouse.click(ev.x, ev.y);
          break;
        case "type":
          await p.keyboard.type(ev.text, { delay: 5 });
          break;
        case "key":
          await p.keyboard.press(ev.key);
          break;
        case "scroll":
          await p.mouse.wheel(0, ev.dy);
          break;
        case "back":
          await p.goBack({ timeout: 10000, waitUntil: "domcontentloaded" }).catch(() => {});
          break;
        case "reload":
          await p.reload({ timeout: 15000, waitUntil: "domcontentloaded" }).catch(() => {});
          break;
      }
      await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
    });
    void this.check();
  }

  private async selectorVisible(): Promise<boolean> {
    const sel = this.o.profile.authenticatedSelector;
    if (!sel) return false;
    for (const p of this.o.ctx.pages()) {
      if (p.isClosed()) continue;
      try {
        if (await p.locator(sel).first().isVisible({ timeout: 250 })) return true;
      } catch {
        /* navigation in progress or invalid selector */
      }
    }
    return false;
  }

  /** Automatic detection: the configured authenticated-state element is visible. */
  async check(): Promise<boolean> {
    if (this.status !== "awaiting-user" || this.checking) return this.status === "authenticated";
    this.checking = true;
    try {
      if (await this.selectorVisible()) await this.finish();
    } finally {
      this.checking = false;
    }
    return (this.status as InteractiveStatus) === "authenticated";
  }

  /**
   * The user states that sign-in is finished. With a configured selector that selector must be
   * visible. Without one the page must have left the login URL and must not show a password field
   * any more — a click on "done" alone is never accepted as proof of authentication.
   */
  async confirm(): Promise<{ ok: boolean; message?: string }> {
    if (this.status === "authenticated") return { ok: true };
    if (this.status !== "awaiting-user") return { ok: false, message: "This sign-in session is no longer active." };
    if (this.o.profile.authenticatedSelector) {
      if (await this.check()) return { ok: true };
      return { ok: false, message: "The authenticated-state element is not visible yet. Finish signing in first." };
    }
    const verdict = await this.run(async () => {
      try {
        const cur = new URL(this.page.url());
        const login = new URL(this.o.profile.loginUrl);
        if (cur.origin === login.origin && cur.pathname === login.pathname) return "The browser is still on the login page.";
        if (await this.page.locator('input[type="password"]').first().isVisible({ timeout: 250 }).catch(() => false)) return "A password field is still visible; sign-in does not look complete.";
        const cookies = await this.o.ctx.cookies();
        const state = await this.o.ctx.storageState();
        if (cookies.length === 0 && state.origins.length === 0) return "The site has not stored any session data yet.";
        return null;
      } catch {
        return "The page could not be inspected.";
      }
    });
    if (verdict) return { ok: false, message: verdict };
    await this.finish();
    return (this.status as InteractiveStatus) === "authenticated" ? { ok: true } : { ok: false, message: this.error };
  }

  private async finish() {
    if (this.status !== "awaiting-user") return;
    try {
      this.sessionState = await this.o.ctx.storageState();
      this.stopTimers();
      this.status = "authenticated";
      await this.o.onAuthenticated(this.o.ctx);
      for (const p of this.o.ctx.pages()) await p.close().catch(() => {});
      this.emit();
      this.settle.resolve();
    } catch (e) {
      await this.end("failed", `The authenticated session could not be captured: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  cancel(message = "The sign-in session was cancelled."): Promise<void> {
    return this.end("cancelled", message);
  }

  private async end(status: Exclude<InteractiveStatus, "awaiting-user" | "authenticated">, message: string) {
    if (this.status !== "awaiting-user") return;
    this.stopTimers();
    this.status = status;
    this.error = message;
    this.sessionState = undefined;
    await Promise.resolve(this.o.onAbandoned(this.o.ctx)).catch(() => {});
    await this.o.ctx.close().catch(() => {});
    this.emit();
    this.settle.reject(new Error(message));
  }

  private emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.status);
      } catch {
        /* listener errors must not break the session */
      }
    }
  }

  private stopTimers() {
    if (this.poll) clearInterval(this.poll);
    if (this.expiry) clearTimeout(this.expiry);
    this.poll = null;
    this.expiry = null;
  }
}
