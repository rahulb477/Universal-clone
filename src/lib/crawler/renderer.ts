import type { Browser, BrowserContext, Page, Request as PwRequest, Response as PwResponse } from "playwright-core";
import { assertPublicUrl } from "./security";
import { USER_AGENT } from "./http";
import type { AuthProfile } from "./auth";
import { classifyGraphql, classifyGraphqlDocument, type ApiObservation } from "./api-discovery";
import { InteractiveLogin, LOGIN_VIEWPORT, type InteractiveReason, type SessionState } from "./interactive-login";

export interface RenderResult {
  html: string;
  finalUrl: string;
  status: number;
  /** Public sub-resources the browser loaded (images, fonts, CSS, media; scripts in full mode). */
  networkAssets: string[];
  /** XHR/fetch URLs observed while rendering. */
  apiCalls: string[];
  /** URLs registered through history.pushState / replaceState (client-side routes). */
  routes: string[];
  /** Detailed fetch/XHR observations (only when API discovery is enabled for this render). */
  api: ApiObservation[];
}

export interface ApiCapture {
  /** Decides (before reading it) whether a response body may be kept in memory for archiving. */
  wantsBody: (url: string, method: string, contentType: string, declaredBytes: number | undefined) => boolean;
  maxBodyBytes: number;
}

export interface RenderOptions {
  mode: "js" | "full";
  timeoutMs: number;
  signal?: AbortSignal;
  /** Optional page-navigation scope check; resources are still governed by SSRF policy. */
  validateNavigation?: (url: string) => boolean;
  api?: ApiCapture;
}

/**
 * Per-context request policy. A context starts in a login phase (if any) and is switched to
 * "crawl" once authentication is verified; from then on it can only read.
 */
export interface ContextPolicy {
  phase: "crawl" | "login-auto" | "login-interactive";
  /** login-auto: the only origin that may receive the (bounded) credential form POSTs. */
  loginOrigin?: string;
  loginPosts: number;
  /** login-interactive: origins the human-driven sign-in may navigate and submit to. */
  authOrigins: Set<string>;
  interactiveMutations: number;
  /** crawl: explicitly authorised GraphQL endpoints (origin + path) whose read-only queries may pass. */
  graphqlEndpoints: Set<string>;
  graphqlRequests: number;
  /** Origins refused during an interactive sign-in, so the user can be told why nothing happened. */
  blockedOrigins: Map<string, number>;
}

export type AuthOutcome = { status: "authenticated" } | { status: "interactive"; login: InteractiveLogin };

const MAX_LOGIN_POSTS = 3;
const MAX_INTERACTIVE_MUTATIONS = 500;
const MAX_GRAPHQL_REQUESTS = 500;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Counting semaphore to keep the number of simultaneous browser contexts small. */
class Gate {
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

const INIT_SCRIPT = `(() => {
  window.__routes = [];
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (s, t, u) {
      try { if (u != null) window.__routes.push(new URL(u, location.href).href); } catch (e) {}
      return orig.apply(this, arguments);
    };
  }
})();`;

const GENERIC_LOGIN_FAILURE = "Login failed or authenticated-state verification timed out. Check the supplied selectors and credentials.";

export class Renderer {
  static lastError = "";
  private authContext: BrowserContext | null = null;
  private navigationGuards = new WeakMap<BrowserContext, (url: string) => boolean>();
  private policies = new WeakMap<BrowserContext, ContextPolicy>();
  private graphqlEndpoints = new Set<string>();
  private constructor(
    readonly browser: Browser,
    private allowPrivate: boolean,
    private gate: Gate,
    private ownsBrowser: boolean,
  ) {}

  /**
   * Returns null (and records lastError) if Chromium cannot be launched.
   * `headed` opens a visible window on the machine running the worker (local desktop use only).
   */
  static async create(allowPrivate: boolean, opts: { headed?: boolean } = {}): Promise<Renderer | null> {
    try {
      const { chromium } = await import("playwright-core");
      const args = ["--disable-dev-shm-usage", "--disable-gpu"];
      if (process.env.CRAWLER_CHROMIUM_SANDBOX !== "1") args.push("--no-sandbox");
      const browser = await chromium.launch({
        headless: !opts.headed,
        args,
        executablePath: process.env.CHROMIUM_PATH || undefined,
      });
      return new Renderer(browser, allowPrivate, new Gate(3), true);
    } catch (e) {
      Renderer.lastError = (e as Error).message.split("\n")[0];
      return null;
    }
  }

  /**
   * A second renderer on the same browser process with its own, fully separate authenticated
   * context (cookies, storage and cache are per context). Used by combined discovery so that several
   * profiles do not each need a browser process.
   */
  share(): Renderer {
    const r = new Renderer(this.browser, this.allowPrivate, this.gate, false);
    r.graphqlEndpoints = this.graphqlEndpoints;
    return r;
  }

  /** Authorises read-only GraphQL queries to exactly these endpoints (origin + path). */
  setGraphqlEndpoints(endpoints: Iterable<string>) {
    this.graphqlEndpoints = new Set(endpoints);
    if (this.authContext) {
      const p = this.policies.get(this.authContext);
      if (p) p.graphqlEndpoints = this.graphqlEndpoints;
    }
  }

  get hasAuthContext() {
    return !!this.authContext;
  }

  /**
   * A context whose every request is validated against the SSRF policy. Outside a login phase all
   * state-changing methods are refused, except read-only queries to authorised GraphQL endpoints.
   */
  async guardedContext(
    viewport = { width: 1366, height: 900 },
    login?: string | { phase: ContextPolicy["phase"]; loginOrigin?: string; authOrigins?: Iterable<string> },
    storageState?: SessionState,
  ): Promise<BrowserContext> {
    const ctx = await this.browser.newContext({
      userAgent: USER_AGENT,
      viewport,
      serviceWorkers: "block",
      acceptDownloads: false,
      ...(storageState ? { storageState } : {}),
    });
    const init = typeof login === "string" ? { phase: "login-auto" as const, loginOrigin: login } : login;
    const policy: ContextPolicy = {
      phase: init?.phase ?? "crawl",
      loginOrigin: init?.loginOrigin,
      loginPosts: 0,
      authOrigins: new Set(init?.authOrigins ?? []),
      interactiveMutations: 0,
      graphqlEndpoints: this.graphqlEndpoints,
      graphqlRequests: 0,
      blockedOrigins: new Map(),
    };
    this.policies.set(ctx, policy);
    const verdicts = new Map<string, Promise<boolean>>();
    await ctx.route("**/*", async (route) => {
      const req = route.request();
      const u = req.url();
      try {
        if (/^(data|blob|about):/i.test(u)) return await route.continue();
        if (!/^https?:/i.test(u)) return await route.abort("blockedbyclient");
        const target = new URL(u);
        const method = req.method();
        if (!SAFE_METHODS.has(method)) {
          let allowed = false;
          if (policy.phase === "login-auto") {
            allowed = policy.loginPosts < MAX_LOGIN_POSTS && method === "POST" && req.resourceType() === "document" && target.origin === policy.loginOrigin;
            if (allowed) policy.loginPosts++;
          } else if (policy.phase === "login-interactive") {
            allowed = policy.authOrigins.has(target.origin) && policy.interactiveMutations < MAX_INTERACTIVE_MUTATIONS;
            if (allowed) policy.interactiveMutations++;
            else policy.blockedOrigins.set(target.origin, (policy.blockedOrigins.get(target.origin) ?? 0) + 1);
          } else if (method === "POST" && policy.graphqlEndpoints.has(target.origin + target.pathname)) {
            allowed = policy.graphqlRequests < MAX_GRAPHQL_REQUESTS && classifyGraphql(req.postData()).operationType === "query";
            if (allowed) policy.graphqlRequests++;
          }
          if (!allowed) return await route.abort("blockedbyclient");
        } else if (policy.phase === "crawl" && method === "GET" && target.searchParams.has("query") && (policy.graphqlEndpoints.has(target.origin + target.pathname) || /graphql/i.test(target.pathname))) {
          // GraphQL over GET: mutations are non-standard there, but refuse them all the same.
          const doc = classifyGraphqlDocument(target.searchParams.get("query") ?? "");
          if (doc.type === "mutation" || doc.type === "subscription") return await route.abort("blockedbyclient");
        }
        if (req.isNavigationRequest()) {
          if (policy.phase === "login-interactive") {
            let topLevel = true;
            try {
              topLevel = req.frame().parentFrame() === null;
            } catch {
              /* frame already gone */
            }
            if (topLevel && !policy.authOrigins.has(target.origin)) {
              policy.blockedOrigins.set(target.origin, (policy.blockedOrigins.get(target.origin) ?? 0) + 1);
              return await route.abort("blockedbyclient");
            }
          } else {
            const navigationGuard = this.navigationGuards.get(ctx);
            if (navigationGuard && !navigationGuard(u)) return await route.abort("blockedbyclient");
          }
        }
        const host = target.hostname;
        let v = verdicts.get(host);
        if (!v) {
          v = assertPublicUrl(u, this.allowPrivate).then(
            () => true,
            () => false,
          );
          verdicts.set(host, v);
        }
        if (await v) await route.continue();
        else await route.abort("blockedbyclient");
      } catch {
        /* context closed mid-request */
      }
    });
    return ctx;
  }

  private interactiveOrigins(profile: AuthProfile, extra: Iterable<string> = []): Set<string> {
    const origins = new Set<string>([new URL(profile.loginUrl).origin]);
    for (const o of profile.allowedAuthOrigins ?? []) origins.add(o);
    for (const o of extra) {
      try {
        origins.add(new URL(o).origin);
      } catch {
        /* ignore malformed scope origin */
      }
    }
    return origins;
  }

  private makeInteractive(ctx: BrowserContext, page: Page, profile: AuthProfile, reason: InteractiveReason, timeoutMs: number): InteractiveLogin {
    const policy = this.policies.get(ctx)!;
    return new InteractiveLogin({
      ctx,
      page,
      profile,
      reason,
      timeoutMs,
      blockedOrigins: () => [...policy.blockedOrigins.keys()].slice(0, 10),
      onAuthenticated: (c) => {
        // From here on the context can only read.
        policy.phase = "crawl";
        policy.authOrigins.clear();
        this.authContext = c;
      },
      onAbandoned: () => {
        policy.phase = "crawl";
      },
    });
  }

  /**
   * Automated form login through the explicitly authorised login origin. A caller-supplied
   * authenticated-state selector is required; redirects alone are not treated as success.
   *
   * If the profile declares an `mfaSelector` and that element appears after the credentials were
   * submitted, the page is handed to the user as an interactive session — the challenge itself is
   * never answered or bypassed here.
   */
  async authenticate(profile: AuthProfile, timeoutMs: number, opts: { interactiveTimeoutMs?: number; scopeOrigins?: string[] } = {}): Promise<AuthOutcome> {
    if (profile.method !== "form") throw new Error("This profile uses manual browser login; start an interactive sign-in instead.");
    if (!profile.authenticatedSelector) throw new Error("Set an authenticated-state selector so login can be verified safely.");
    await assertPublicUrl(profile.loginUrl, this.allowPrivate);
    const origin = new URL(profile.loginUrl).origin;
    const ctx = await this.guardedContext(profile.mfaSelector ? LOGIN_VIEWPORT : undefined, origin);
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeoutMs);
    let handedOver = false;
    try {
      await page.goto(profile.loginUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const userSelector = profile.usernameSelector || 'input[type="email"], input[name*="user" i], input[autocomplete="username"]';
      const passSelector = profile.passwordSelector || 'input[type="password"]';
      const user = page.locator(userSelector).first();
      if (!(await user.count())) throw new Error("Could not locate the username field; configure its selector.");
      await user.fill(profile.username);
      const password = page.locator(passSelector).first();
      if (!(await password.count())) {
        await this.submitLogin(page, profile);
        await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      }
      const passwordAfterStep = page.locator(passSelector).first();
      if (!(await passwordAfterStep.count())) throw new Error("The login page did not reveal a password field after the username step.");
      await passwordAfterStep.fill(profile.password);
      await this.submitLogin(page, profile);
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      const authenticated = page.locator(profile.authenticatedSelector);
      if (profile.mfaSelector) {
        const challenge = page.locator(profile.mfaSelector);
        await authenticated.or(challenge).first().waitFor({ state: "visible", timeout: timeoutMs });
        if (!(await authenticated.first().isVisible().catch(() => false))) {
          // A human verification step is showing. Hand the live page to the user.
          const policy = this.policies.get(ctx)!;
          policy.phase = "login-interactive";
          policy.authOrigins = this.interactiveOrigins(profile, opts.scopeOrigins);
          handedOver = true;
          return { status: "interactive", login: this.makeInteractive(ctx, page, profile, "mfa", opts.interactiveTimeoutMs ?? 10 * 60 * 1000) };
        }
      } else {
        await authenticated.first().waitFor({ state: "visible", timeout: timeoutMs });
      }
      const policy = this.policies.get(ctx)!;
      policy.phase = "crawl";
      this.authContext = ctx;
      return { status: "authenticated" };
    } catch (e) {
      await ctx.close().catch(() => {});
      const message = (e as Error).message;
      const safe = ["Could not locate the username field; configure its selector.", "The login page did not reveal a password field after the username step."].includes(message) ? message : GENERIC_LOGIN_FAILURE;
      throw new Error(safe);
    } finally {
      if (!handedOver) await page.close().catch(() => {});
    }
  }

  /**
   * Opens the login page in a fresh isolated context for the user to sign in by hand
   * (including any MFA or CAPTCHA the site presents — those are the user's to solve).
   */
  async beginInteractiveLogin(profile: AuthProfile, opts: { timeoutMs: number; navigationTimeoutMs?: number; scopeOrigins?: string[]; reason?: InteractiveReason }): Promise<InteractiveLogin> {
    await assertPublicUrl(profile.loginUrl, this.allowPrivate);
    const ctx = await this.guardedContext(LOGIN_VIEWPORT, { phase: "login-interactive", authOrigins: this.interactiveOrigins(profile, opts.scopeOrigins) });
    try {
      const page = await ctx.newPage();
      page.setDefaultTimeout(opts.navigationTimeoutMs ?? 20000);
      await page.goto(profile.loginUrl, { waitUntil: "domcontentloaded", timeout: opts.navigationTimeoutMs ?? 20000 });
      return this.makeInteractive(ctx, page, profile, opts.reason ?? "manual-login", opts.timeoutMs);
    } catch (e) {
      await ctx.close().catch(() => {});
      throw new Error(`The login page could not be opened: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  /** Recreates an authenticated context from a previously captured (decrypted) session state. */
  async restoreSession(state: SessionState): Promise<void> {
    await this.clearAuthContext();
    this.authContext = await this.guardedContext(undefined, undefined, state);
  }

  /** Captures the current authenticated session. The result is a secret and must be encrypted at rest. */
  async exportSession(): Promise<SessionState | null> {
    return this.authContext ? this.authContext.storageState() : null;
  }

  /**
   * `Cookie` header value the authenticated context would send to `url` (domain, path, Secure and
   * expiry rules are applied by the browser's own cookie jar). Empty when nothing matches.
   */
  async cookieHeader(url: string): Promise<string> {
    if (!this.authContext) return "";
    try {
      const cookies = await this.authContext.cookies(url);
      return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch {
      return "";
    }
  }

  private async submitLogin(page: Page, profile: AuthProfile) {
    if (profile.loginButtonSelector) {
      await page.locator(profile.loginButtonSelector).click();
      return;
    }
    const pass = page.locator(profile.passwordSelector || 'input[type="password"]').first();
    if (await pass.count()) await pass.press("Enter");
    else await page.locator(profile.usernameSelector || 'input[type="email"], input[name*="user" i]').first().press("Enter");
  }

  async clearAuthContext() {
    const ctx = this.authContext;
    this.authContext = null;
    await ctx?.close().catch(() => {});
  }

  async render(url: string, o: RenderOptions, existingContext?: BrowserContext): Promise<RenderResult> {
    await this.gate.acquire();
    let ctx: BrowserContext | null = null;
    const onAbort = () => ctx?.close().catch(() => {});
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const authCtx = this.authContext;
    let page: Page | null = null;
    try {
      ctx = existingContext ?? authCtx ?? (await this.guardedContext());
      if (o.validateNavigation) this.navigationGuards.set(ctx, o.validateNavigation);
      const policy = this.policies.get(ctx);
      page = await ctx.newPage();
      page.setDefaultTimeout(o.timeoutMs);
      const networkAssets = new Set<string>();
      const apiCalls = new Set<string>();
      const api: ApiObservation[] = [];
      const pending: Promise<void>[] = [];
      const captureApi = async (resp: PwResponse, req: PwRequest, type: "xhr" | "fetch") => {
        const headers = resp.headers();
        const contentType = headers["content-type"] ?? "";
        const declared = headers["content-length"] !== undefined && /^\d+$/.test(headers["content-length"]) ? Number(headers["content-length"]) : undefined;
        const method = req.method();
        const u = resp.url();
        const obs: ApiObservation = { url: u, method, resourceType: type, status: resp.status(), contentType, bytes: declared, linkHeader: headers["link"], cacheControl: headers["cache-control"] };
        if (method === "POST") {
          try {
            const t = new URL(u);
            if (policy?.graphqlEndpoints.has(t.origin + t.pathname)) obs.graphql = classifyGraphql(req.postData());
          } catch {
            /* ignore */
          }
        }
        if (o.api!.wantsBody(u, method, contentType, declared)) {
          try {
            const body = await resp.body();
            obs.bytes = body.length;
            if (body.length <= o.api!.maxBodyBytes) obs.body = body;
          } catch {
            /* body no longer available (navigation, aborted) */
          }
        }
        api.push(obs);
      };
      page.on("response", (resp) => {
        try {
          const req = resp.request();
          const t = req.resourceType();
          const u = resp.url();
          if (!/^https?:/.test(u)) return;
          if (t === "xhr" || t === "fetch") {
            if (resp.status() < 400) apiCalls.add(u);
            if (o.api && api.length + pending.length < 500) pending.push(captureApi(resp, req, t).catch(() => {}));
            return;
          }
          if (resp.status() >= 400) return;
          if (t === "image" || t === "font" || t === "stylesheet" || t === "media" || (t === "script" && o.mode === "full")) networkAssets.add(u);
        } catch {
          /* ignore */
        }
      });
      if (o.api) {
        // State-changing requests refused by the guard: listed in the report, never sent.
        page.on("requestfailed", (req) => {
          try {
            const method = req.method();
            const u = req.url();
            if (SAFE_METHODS.has(method) || !/^https?:/.test(u) || api.length >= 500) return;
            if (!/blocked_?by_?client/i.test(req.failure()?.errorText ?? "")) return;
            const t = req.resourceType();
            const target = new URL(u);
            const obs: ApiObservation = { url: u, method, resourceType: t === "xhr" ? "xhr" : "fetch", status: 0, contentType: "", blocked: true, blockReason: `${method} requests are never sent while crawling` };
            if (/graphql/i.test(target.pathname) || policy?.graphqlEndpoints.has(target.origin + target.pathname)) {
              obs.graphql = classifyGraphql(req.postData());
              obs.blockReason = policy?.graphqlEndpoints.has(target.origin + target.pathname)
                ? obs.graphql.operationType === "query"
                  ? "GraphQL request limit reached"
                  : `GraphQL ${obs.graphql.operationType === "unknown" ? "operation could not be verified as read-only" : obs.graphql.operationType} refused`
                : "GraphQL endpoint is not explicitly authorised";
            }
            api.push(obs);
          } catch {
            /* ignore */
          }
        });
      }
      await page.addInitScript(INIT_SCRIPT);
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: o.timeoutMs });
      await page.waitForLoadState("networkidle", { timeout: Math.min(o.timeoutMs, 8000) }).catch(() => {});
      await stabilize(page);
      await autoScroll(page);
      if (o.mode === "full") await interact(page);
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      await stabilize(page, 3000);
      const routes = (await page.evaluate(() => (window as unknown as { __routes?: string[] }).__routes || []).catch(() => [])) as string[];
      const html = await page.evaluate(() => {
        // Materialise CSSOM-only rules (CSS-in-JS "speedy" mode) so they survive serialisation.
        for (const s of Array.from(document.querySelectorAll("style"))) {
          try {
            if (!(s.textContent || "").trim() && s.sheet) {
              s.textContent = Array.from(s.sheet.cssRules)
                .map((r) => r.cssText)
                .join("\n");
            }
          } catch {
            /* cross-origin sheet */
          }
        }
        return "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
      });
      // Response bodies must be read before the page is closed.
      await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 5000))]);
      const finalUrl = page.url();
      return {
        html,
        finalUrl,
        status: resp?.status() ?? 0,
        networkAssets: [...networkAssets],
        apiCalls: [...apiCalls],
        routes,
        api,
      };
    } finally {
      o.signal?.removeEventListener("abort", onAbort);
      // The authenticated context is long-lived: close only the page, keep the context.
      if (ctx && (ctx === authCtx || ctx === existingContext)) await page?.close().catch(() => {});
      else if (ctx) await ctx.close().catch(() => {});
      this.gate.release();
    }
  }

  async close() {
    await this.clearAuthContext();
    if (this.ownsBrowser) await this.browser.close().catch(() => {});
  }
}

/** Waits until the DOM size stops changing (three identical samples) or maxMs passes. */
export async function stabilize(page: Page, maxMs = 5000) {
  let last = -1;
  let same = 0;
  const end = Date.now() + maxMs;
  while (Date.now() < end && same < 3) {
    const len = await page.evaluate(() => document.documentElement.outerHTML.length).catch(() => -1);
    if (len === last) same++;
    else {
      same = 0;
      last = len;
    }
    await page.waitForTimeout(250);
  }
}

/** Scrolls through the page so IntersectionObserver / lazy-loading content is requested. */
export async function autoScroll(page: Page) {
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        let steps = 0;
        let lastHeight = 0;
        let stable = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, Math.max(300, Math.floor(window.innerHeight * 0.8)));
          steps++;
          const h = document.documentElement.scrollHeight;
          const atBottom = window.scrollY + window.innerHeight >= h - 2;
          if (atBottom && h === lastHeight) stable++;
          else stable = 0;
          lastHeight = h;
          if (stable >= 2 || steps >= 40) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 150);
      });
    })
    .catch(() => {});
}

/**
 * Full mode only: clicks "load more"-style controls. Never touches forms, submit
 * buttons or anchors with real destinations.
 */
export async function interact(page: Page) {
  for (let i = 0; i < 5; i++) {
    const clicked = await page
      .evaluate(() => {
        const re = /^\s*(load|show|view|see)\s+more\b|^\s*more\s*$/i;
        const els = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button], a[href='#'], .load-more, [data-load-more]"));
        for (const el of els) {
          if (el.closest("form")) continue;
          if ((el as HTMLButtonElement).type === "submit") continue;
          const a = el as HTMLAnchorElement;
          if (el.tagName === "A" && a.getAttribute("href") !== "#") continue;
          if (!re.test(el.textContent || "") && !el.matches(".load-more, [data-load-more]")) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || (el as HTMLButtonElement).disabled) continue;
          if (el.getAttribute("data-crawler-clicked")) continue;
          el.setAttribute("data-crawler-clicked", "1");
          el.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (!clicked) break;
    await page.waitForTimeout(700);
    await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
  }
}
