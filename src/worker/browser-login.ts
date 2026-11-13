import { hostMatchesScope, scopeSessionState, type ProfileScope } from "@/lib/crawler/saved-login";
import type { Renderer } from "@/lib/crawler/renderer";
import { InteractiveLogin, type InteractiveReason, type SessionState, type LoginInput } from "@/lib/crawler/interactive-login";

/**
 * The "Login with Browser" window of a reusable profile — the same isolated-browser machinery a
 * crawl uses for its manual sign-in (`src/lib/crawler/interactive-login.ts`), running outside any
 * crawl: the user signs in on the real site, presses "Use This Login", and the worker captures the
 * session for later jobs.
 *
 * Nothing is typed, clicked or solved for the user. Navigation is confined to the profile's site
 * (its host, plus subdomains when the profile allows them); anything else is refused by the
 * renderer's request policy and reported back, so a session for one site can never be collected
 * while the window is pointed at another.
 */

export type BrowserLoginReason = InteractiveReason;
export type BrowserLoginStatus = "awaiting-user" | "authenticated" | "failed" | "cancelled" | "expired";

export interface BrowserLoginInit {
  profileId: string;
  profileName: string;
  scope: ProfileScope;
  /** Where the window opens: the site's sign-in page when known, else the start page. */
  entryUrl: string;
  authenticatedSelector?: string | null;
  reason: BrowserLoginReason;
  timeoutMs: number;
  renderer: Renderer;
  /** Called once with the captured (already site-scoped) session. Must persist it encrypted. */
  onAuthenticated: (state: SessionState) => Promise<void> | void;
  /** Called when the window ends without a session. */
  onAbandoned: (reason: string) => Promise<void> | void;
}

export interface BrowserLoginView {
  id: string;
  profileId: string;
  status: BrowserLoginStatus;
  /** Origin + path of the page in the window; query strings are dropped (they can carry codes). */
  url: string;
  blockedOrigins: string[];
  message: string | null;
}

export class BrowserLogin {
  status: BrowserLoginStatus = "awaiting-user";
  sessionState?: SessionState;
  error?: string;
  lastActivityAt = Date.now();
  readonly startedAt = Date.now();
  readonly expiresAt: number;
  private interactive: InteractiveLogin | null = null;
  private listeners = new Set<(v: BrowserLoginView) => void>();
  private settled = false;
  private readonly done: Promise<void>;
  private settle!: { resolve: () => void; reject: (e: Error) => void };

  constructor(private readonly o: BrowserLoginInit) {
    this.expiresAt = this.startedAt + o.timeoutMs;
    this.done = new Promise<void>((resolve, reject) => (this.settle = { resolve, reject }));
    this.done.catch(() => {});
  }

  get id(): string {
    return this.interactive?.id ?? "";
  }

  get profileId(): string {
    return this.o.profileId;
  }

  get reason(): BrowserLoginReason {
    return this.o.reason;
  }

  /** Opens the isolated context and loads the entry page. Throws with a message fit for the user. */
  async open(): Promise<void> {
    const login = await this.o.renderer.beginInteractiveLogin(
      {
        id: this.o.profileId,
        name: this.o.profileName,
        loginUrl: this.o.entryUrl,
        username: "",
        password: "",
        method: "manual",
        ...(this.o.authenticatedSelector ? { authenticatedSelector: this.o.authenticatedSelector } : {}),
      },
      {
        timeoutMs: this.o.timeoutMs,
        navigationTimeoutMs: 30_000,
        reason: this.o.reason,
        hostScope: this.o.scope,
      },
    );
    this.interactive = login;
    login.onStatus((s) => {
      if (s === "awaiting-user") return;
      if (s === "authenticated") void this.capture();
      else if (!this.settled) void this.fail(s === "expired" ? "The sign-in window timed out before a login was saved." : s === "cancelled" ? (login.error ?? "The sign-in window was closed.") : (login.error ?? "Sign-in failed."), s);
    });
    // The interactive session may already have ended while this was being set up.
    if (login.status !== "awaiting-user") {
      if (login.status === "authenticated") await this.capture();
      else if (!this.settled) await this.fail(login.error ?? "Sign-in failed.", login.status);
    }
  }

  wait(): Promise<void> {
    return this.done;
  }

  onStatus(fn: (v: BrowserLoginView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** True when the window is open but untouched for `ms` (the worker then stops holding it). */
  idleFor(ms: number): boolean {
    return this.status === "awaiting-user" && Date.now() - this.lastActivityAt > ms;
  }

  view(): BrowserLoginView {
    const info = this.interactive?.info();
    return {
      id: this.id,
      profileId: this.o.profileId,
      status: this.status,
      url: info?.url ?? "",
      blockedOrigins: info?.blockedOrigins ?? [],
      message: this.error ?? null,
    };
  }

  frame(): Promise<Buffer | null> {
    return this.interactive?.frame() ?? Promise.resolve(null);
  }

  async input(event: LoginInput): Promise<void> {
    this.lastActivityAt = Date.now();
    await this.interactive?.input(event);
  }

  /**
   * "Use This Login". The interactive session only reports success when the configured
   * authenticated-state element is visible, or — without one — when the page has demonstrably left
   * the sign-in form and the site has stored session data. A click alone is never enough.
   */
  async confirm(): Promise<{ ok: boolean; message?: string }> {
    this.lastActivityAt = Date.now();
    if (this.status === "authenticated") return { ok: true };
    if (this.status !== "awaiting-user" || !this.interactive) return { ok: false, message: "This sign-in window is no longer open. Choose “Login with Browser” again." };
    const r = await this.interactive.confirm();
    if (!r.ok) {
      this.error = r.message ?? "Sign-in does not look complete yet.";
      this.emit();
    }
    return r;
  }

  cancel(message = "The sign-in window was closed."): Promise<void> {
    return this.interactive?.cancel(message) ?? Promise.resolve();
  }

  private async capture() {
    if (this.settled) return;
    const state = this.interactive?.sessionState;
    if (!state) return this.fail("The browser did not provide a session to save.", "failed");
    const scoped = scopeSessionState(this.o.scope, state);
    if (scoped.cookies.length === 0) {
      return this.fail(`No session cookie for ${this.o.scope.targetHost} was captured, so nothing was saved. Sign in, then press “Use This Login” again.`, "failed");
    }
    try {
      await this.o.onAuthenticated(scoped);
      this.sessionState = scoped;
      this.status = "authenticated";
      this.settled = true;
      this.emit();
      this.settle.resolve();
    } catch (e) {
      await this.fail((e as Error).message, "failed");
    }
  }

  private async fail(message: string, status: BrowserLoginStatus) {
    if (this.settled) return;
    this.settled = true;
    this.status = status;
    this.error = message;
    await Promise.resolve(this.o.onAbandoned(message)).catch(() => {});
    this.emit();
    this.settle.reject(new Error(message));
  }

  private emit() {
    const v = this.view();
    for (const fn of this.listeners) {
      try {
        fn(v);
      } catch {
        /* a listener must never break the window */
      }
    }
  }
}

/** True when a captured session still holds at least one cookie for the profile's site. */
export function sessionHasSiteCookies(scope: ProfileScope, state: SessionState): boolean {
  return (state.cookies ?? []).some((c) => hostMatchesScope(scope, c.domain.replace(/^\./, "")));
}
