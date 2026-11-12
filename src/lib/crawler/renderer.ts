import type { Browser, BrowserContext, Page } from "playwright-core";
import { assertPublicUrl } from "./security";
import { USER_AGENT } from "./http";
import type { AuthProfile } from "./auth";

export interface RenderResult {
  html: string;
  finalUrl: string;
  status: number;
  /** Public sub-resources the browser loaded (images, fonts, CSS, media; scripts in full mode). */
  networkAssets: string[];
  /** XHR/fetch URLs — dynamic functionality that cannot be archived. */
  apiCalls: string[];
  /** URLs registered through history.pushState / replaceState (client-side routes). */
  routes: string[];
}

export interface RenderOptions {
  mode: "js" | "full";
  timeoutMs: number;
  signal?: AbortSignal;
  /** Optional page-navigation scope check; resources are still governed by SSRF policy. */
  validateNavigation?: (url: string) => boolean;
}

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

export class Renderer {
  static lastError = "";
  private gate = new Gate(3);
  private closeLoginWindows = new WeakMap<BrowserContext, () => void>();
  private authContext: BrowserContext | null = null;
  private navigationGuards = new WeakMap<BrowserContext, (url: string) => boolean>();
  private constructor(
    readonly browser: Browser,
    private allowPrivate: boolean,
  ) {}

  /** Returns null (and records lastError) if Chromium cannot be launched. */
  static async create(allowPrivate: boolean): Promise<Renderer | null> {
    try {
      const { chromium } = await import("playwright-core");
      const args = ["--disable-dev-shm-usage", "--disable-gpu"];
      if (process.env.CRAWLER_CHROMIUM_SANDBOX !== "1") args.push("--no-sandbox");
      const browser = await chromium.launch({
        headless: true,
        args,
        executablePath: process.env.CHROMIUM_PATH || undefined,
      });
      return new Renderer(browser, allowPrivate);
    } catch (e) {
      Renderer.lastError = (e as Error).message.split("\n")[0];
      return null;
    }
  }

  /** A context whose every request is validated against the SSRF policy; mutating methods are refused. */
  async guardedContext(viewport = { width: 1366, height: 900 }, loginOrigin?: string): Promise<BrowserContext> {
    const ctx = await this.browser.newContext({
      userAgent: USER_AGENT,
      viewport,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const verdicts = new Map<string, Promise<boolean>>();
    let loginPhase = !!loginOrigin;
    let loginPosts = 0;
    this.closeLoginWindows.set(ctx, () => { loginPhase = false; });
    await ctx.route("**/*", async (route) => {
      const req = route.request();
      const u = req.url();
      try {
        if (/^(data|blob|about):/i.test(u)) return await route.continue();
        if (!/^https?:/i.test(u)) return await route.abort("blockedbyclient");
        const authorizedLoginPost = loginPhase && loginPosts < 3 && req.method() === "POST" && req.resourceType() === "document" && new URL(u).origin === loginOrigin;
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method()) && !authorizedLoginPost) return await route.abort("blockedbyclient");
        if (authorizedLoginPost) loginPosts++;
        const navigationGuard = this.navigationGuards.get(ctx);
        if (req.isNavigationRequest() && navigationGuard && !navigationGuard(u)) return await route.abort("blockedbyclient");
        const host = new URL(u).hostname;
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

  /** Logs in only through the explicitly authorized login origin. A caller-supplied
   * authenticated-state selector is required; redirects alone are not treated as success. */
  async authenticate(profile: AuthProfile, timeoutMs: number): Promise<void> {
    if (profile.method !== "form") throw new Error("Manual browser login is not available in the current server deployment.");
    if (!profile.authenticatedSelector) throw new Error("Set an authenticated-state selector so login can be verified safely.");
    await assertPublicUrl(profile.loginUrl, this.allowPrivate);
    const origin = new URL(profile.loginUrl).origin;
    const ctx = await this.guardedContext(undefined, origin);
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeoutMs);
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
      await page.locator(profile.authenticatedSelector).waitFor({ state: "visible", timeout: timeoutMs });
      this.closeLoginWindows.get(ctx)?.();
      this.authContext = ctx;
    } catch (e) {
      await ctx.close().catch(() => {});
      const message = (e as Error).message;
      const safe = ["Could not locate the username field; configure its selector.", "The login page did not reveal a password field after the username step."].includes(message)
        ? message
        : "Login failed or authenticated-state verification timed out. Check the supplied selectors and credentials.";
      throw new Error(safe);
    } finally {
      await page.close().catch(() => {});
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
    try {
      ctx = existingContext ?? this.authContext ?? await this.guardedContext();
      if (o.validateNavigation) this.navigationGuards.set(ctx, o.validateNavigation);
      const page = await ctx.newPage();
      page.setDefaultTimeout(o.timeoutMs);
      const networkAssets = new Set<string>();
      const apiCalls = new Set<string>();
      page.on("response", (resp) => {
        try {
          if (resp.status() >= 400) return;
          const t = resp.request().resourceType();
          const u = resp.url();
          if (!/^https?:/.test(u)) return;
          if (t === "image" || t === "font" || t === "stylesheet" || t === "media" || (t === "script" && o.mode === "full")) networkAssets.add(u);
          else if (t === "xhr" || t === "fetch") apiCalls.add(u);
        } catch {
          /* ignore */
        }
      });
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
      return {
        html,
        finalUrl: page.url(),
        status: resp?.status() ?? 0,
        networkAssets: [...networkAssets],
        apiCalls: [...apiCalls],
        routes,
      };
    } finally {
      o.signal?.removeEventListener("abort", onAbort);
      if (ctx && ctx !== this.authContext) await ctx.close().catch(() => {});
      this.gate.release();
    }
  }

  async close() {
    await this.browser.close().catch(() => {});
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
