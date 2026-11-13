import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAuthSite } from "../fixtures/auth-site";
import { requireChromium } from "../helpers";
import { startPostgres, type TestPostgres } from "../setup/postgres";
import { bootWeb, type Web } from "../setup/server";

/**
 * Drives the "Login with Browser" workflow in a real browser against the production build
 * (`npm run build` first), against the real PostgreSQL schema and a real worker (inline mode):
 *
 *   Step 1 URL → Step 2 "Login with Browser" → isolated browser, the user signs in by hand →
 *   "Use This Login" → "Login profile saved" → profile attached to the crawl → authenticated ZIP.
 *
 * It also checks the mobile layout (390 px, no horizontal overflow) and that the profile of one
 * site cannot be selected for another.
 */

let pg: TestPostgres;
let site: Awaited<ReturnType<typeof startAuthSite>>;
let other: Awaited<ReturnType<typeof startAuthSite>>;
let web: Web;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const problems: string[] = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-saved-login-ui-"));
/** Set SHOT_DIR to keep the screenshots of this run (they are deleted with the temp directory otherwise). */
const shotDir = process.env.SHOT_DIR || dataDir;
const EMAIL = "saved-ui@example.test";
const PASSWORD = "a password for the saved login ui";
const SITE_USER = "member@example.test";
const SITE_PASSWORD = `pw-${SITE_USER}`;

beforeAll(async () => {
  const executablePath = requireChromium();
  pg = await startPostgres();
  await pg.migrate(pg.url);
  site = await startAuthSite({ rich: true });
  other = await startAuthSite({ rich: true });
  web = await bootWeb({
    DATABASE_URL: pg.url,
    CRAWL_DATA_DIR: dataDir,
    CRAWLER_WORKER_MODE: "inline",
    CRAWLER_ALLOW_PRIVATE_NETWORKS: "1",
    AUTH_REGISTRATION: "open",
    CRAWLER_STARTS_PER_MINUTE: "100",
  });
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("/api/auth/login")) problems.push(`HTTP ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
}, 180000);

afterAll(async () => {
  await browser?.close();
  await web?.stop();
  await site?.close();
  await other?.close();
  await pg?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** No horizontal overflow anywhere on the page (mobile-first layout). */
async function overflows(p: Page) {
  return p.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 40)}`);
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, wide: wide.slice(0, 5) };
  });
}

describe("Login with Browser, in the real UI", () => {
  it("signs up, then shows the address field, the Login with Browser button and the saved-login panel", async () => {
    await page.goto(web.base + "/");
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.fill("#acc-email", EMAIL);
    await page.fill("#acc-password", PASSWORD);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.getByText("Account created. Sign in to continue.").waitFor();
    await page.fill("#acc-password", PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("input[aria-label='Website URL']").waitFor();
    problems.length = 0;

    // Step 1: the address, and a clearly visible authentication option.
    await page.fill("input[aria-label='Website URL']", `${site.url}/dashboard`);
    const loginWithBrowser = page.getByRole("button", { name: "Login with Browser" });
    await expect.poll(() => loginWithBrowser.isVisible()).toBe(true);
    await loginWithBrowser.click();
    await page.getByText("No saved logins yet").waitFor();
    expect(await page.getByRole("tab", { name: "Saved login" }).isVisible()).toBe(true);
  });

  it("creates a login profile and opens the real site in an isolated browser", async () => {
    await page.getByRole("button", { name: "+ Save a login for another site" }).click();
    await page.fill("#profile-name", "Member account");
    await page.fill("#profile-site", `${site.url}/login`);
    await page.getByRole("button", { name: "Create profile" }).click();

    const profileRow = page.locator("li").filter({ hasText: "Member account" });
    await profileRow.waitFor({ timeout: 30000 });
    // A fresh profile has no login yet and says so.
    expect(await profileRow.innerText()).toMatch(/needs a sign-in|no login saved|sign in/i);
    await profileRow.getByRole("button", { name: "Login with Browser" }).click();

    // The worker opens the fixture's sign-in page in its own browser; the panel shows a live picture.
    const panel = page.locator("section[aria-label='Browser sign-in']");
    await panel.waitFor({ timeout: 60000 });
    await expect.poll(() => panel.innerText(), { timeout: 30000 }).toContain(`${site.url}/login`);
    await panel.locator("img").waitFor({ timeout: 30000 });
    const dims = await panel.locator("img").evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, h: img.naturalHeight }));
    expect(dims.w).toBeGreaterThan(100);
    expect(dims.h).toBeGreaterThan(100);
    // The real site asked for nothing yet: the user has not typed anything.
    expect(site.stats.hits["/login"]).toBeUndefined();
    expect(await panel.getByRole("button", { name: "Use This Login" }).isVisible()).toBe(true);
    expect(await panel.getByRole("button", { name: "Cancel" }).isVisible()).toBe(true);
    await page.screenshot({ path: path.join(shotDir, "browser-login.png") });
  });

  it("refuses to save a login before the user has signed in", async () => {
    const panel = page.locator("section[aria-label='Browser sign-in']");
    await panel.getByRole("button", { name: "Use This Login" }).click();
    // The worker checks the real page: it is still the sign-in form, so nothing is saved, the window
    // stays open for another try and the reason is shown.
    await expect.poll(() => panel.innerText(), { timeout: 30000 }).toMatch(/still on the login page/i);
    expect(await panel.locator("img").isVisible()).toBe(true);
    expect(await pg.query("select count(*)::int as n from saved_login_sessions")).toEqual([{ n: 0 }]);
  });

  it("lets the user sign in by hand, saves the login, and reports it", async () => {
    const panel = page.locator("section[aria-label='Browser sign-in']");
    const picture = panel.locator("img");
    await picture.waitFor({ timeout: 20000 });
    await picture.focus();
    // Keyboard only, exactly as a person would: Tab to the first field, type, Tab, type, Enter.
    await page.keyboard.press("Tab");
    await page.keyboard.type(SITE_USER);
    await page.keyboard.press("Tab");
    await page.keyboard.type(SITE_PASSWORD);
    await page.keyboard.press("Enter");
    // Step 3: the user presses "Use This Login". The worker checks that the page really is signed in,
    // captures the session, encrypts it and confirms; the window then closes.
    await expect.poll(() => site.stats.loginPosts, { timeout: 30000 }).toBe(1);
    await expect.poll(() => panel.innerText(), { timeout: 30000 }).toContain(`${site.url}/dashboard`);
    // The refusal from the previous step is still on screen; the user simply tries again.
    await panel.getByRole("button", { name: "Use This Login" }).click();
    await panel.waitFor({ state: "detached", timeout: 60000 });
    await expect.poll(() => page.locator("body").innerText(), { timeout: 30000 }).toContain("Login profile saved");
    expect(site.stats.loginPosts).toBe(1);

    // The profile now shows an active login, and the page never received the session material.
    const row = page.locator("li").filter({ hasText: "Member account" });
    await expect.poll(() => row.innerText(), { timeout: 15000 }).toMatch(/login (saved|active)|session cookie/i);
    expect(await row.getByRole("button", { name: "Sign in again" }).isVisible()).toBe(true);
    const html = await page.content();
    expect(html).not.toContain(SITE_PASSWORD);
    expect(html.toLowerCase()).not.toContain("sid=");
    // At rest the session is an AES-256-GCM envelope, never the cookie value.
    const sealed = await pg.query<any>("select state from saved_login_sessions");
    expect(sealed).toHaveLength(1);
    expect(sealed[0].state).toMatch(/^v2\./);
    expect(sealed[0].state).not.toContain("sid=");
    // The typed credentials were never persisted anywhere.
    const dump = JSON.stringify([await pg.query("select * from target_login_profiles"), await pg.query("select * from login_sessions"), await pg.query("select * from login_profile_commands")]);
    expect(dump).not.toContain(SITE_PASSWORD);
    expect(dump).not.toContain(SITE_USER);
  });

  it("attaches the saved login to the download and crawls the signed-in pages", async () => {
    const row = page.locator("li").filter({ hasText: "Member account" });
    await row.getByRole("checkbox").check();
    await page.getByLabel(/I own this website or have permission/).check();
    await page.getByRole("button", { name: "Start download" }).click();

    const live = page.locator("section").filter({ has: page.getByRole("heading", { name: "Live crawl" }) });
    await live.waitFor({ timeout: 30000 });
    await expect.poll(() => live.innerText(), { timeout: 180000, interval: 500 }).toContain("completed");
    // The crawl reused the saved login instead of signing in again.
    expect(site.stats.loginPosts).toBe(1);
    await expect.poll(() => live.innerText()).toContain("Restored the saved login profile");
    expect(await page.locator("[role=progressbar]").getAttribute("aria-valuenow")).toBe("100");

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: /Download ZIP/ }).click()]);
    const file = path.join(dataDir, "saved-login.zip");
    await download.saveAs(file);
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(file);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names.some((n) => n.includes("dashboard/index.html"))).toBe(true);
    expect(zip.readAsText(names.find((n) => n.includes("dashboard/index.html"))!)).toContain(`Account ${SITE_USER}`);
    for (const e of zip.getEntries()) expect(e.getData().includes(SITE_PASSWORD), e.entryName).toBe(false);
    expect(web.output()).not.toContain(SITE_PASSWORD);
    // What the worker did with the session is reported, without the session itself.
    expect(await live.innerText()).toContain("saved login");
    expect(problems).toEqual([]);
  });

  it("keeps each login tied to its own site", async () => {
    await page.fill("input[aria-label='Website URL']", `${other.url}/dashboard`);
    const row = page.locator("li").filter({ hasText: "Member account" });
    // The panel explains why the saved login cannot be used here, and refuses to select it.
    await expect.poll(() => page.locator("body").innerText(), { timeout: 15000 }).toMatch(/Not for this address/);
    expect(await row.getByRole("checkbox").isDisabled()).toBe(true);
    const csrf = (await (await page.request.get(web.base + "/api/auth/me")).json()).csrfToken as string;
    const api = await page.request.post(web.base + "/api/crawl", {
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      data: { url: `${other.url}/dashboard`, confirmPermission: true, savedProfileIds: [(await pg.query<any>("select id from target_login_profiles"))[0].id] },
    });
    expect(api.status()).toBe(400);
    expect((await api.json()).error).toMatch(/cannot be used for/i);
    expect(await pg.query("select count(*)::int as n from crawl_jobs")).toEqual([{ n: 1 }]);
    await page.fill("input[aria-label='Website URL']", `${site.url}/dashboard`);
  });

  it("fits a phone screen without horizontal scrolling, with large touch targets", async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    const p = await phone.newPage();
    const cookies = await context.cookies();
    await phone.addCookies(cookies.map((c) => ({ ...c, domain: new URL(web.base).hostname })));
    await p.goto(web.base + "/");
    await p.locator("input[aria-label='Website URL']").waitFor();
    await p.getByRole("button", { name: "Login with Browser" }).click();
    await p.locator("li").filter({ hasText: "Member account" }).waitFor({ timeout: 30000 });

    const box = await overflows(p);
    expect(box.scrollWidth, JSON.stringify(box.wide)).toBeLessThanOrEqual(box.clientWidth + 1);
    // The two primary actions are reachable with a thumb.
    for (const button of [p.getByRole("button", { name: "Login with Browser" }).first(), p.getByRole("button", { name: "Start download" })]) {
      const size = await button.boundingBox();
      expect(size!.height).toBeGreaterThanOrEqual(40);
    }
    await p.screenshot({ path: path.join(shotDir, "mobile.png"), fullPage: true });
    await phone.close();
  });

  it("re-signs in after the login is forgotten, and deletes the profile", async () => {
    await page.locator("input[aria-label='Website URL']").fill(`${site.url}/dashboard`);
    const row = page.locator("li").filter({ hasText: "Member account" });
    page.once("dialog", (d) => void d.accept());
    await row.getByRole("button", { name: "Forget login" }).click();
    await expect.poll(() => page.locator("body").innerText(), { timeout: 20000 }).toContain("Saved login removed");
    await expect.poll(() => row.innerText(), { timeout: 15000 }).toMatch(/no login saved/i);
    expect(await row.getByRole("button", { name: "Login with Browser" }).isVisible()).toBe(true);
    // A rejected/absent session never drops the profile itself.
    expect(await pg.query("select count(*)::int as n from target_login_profiles")).toEqual([{ n: 1 }]);
    expect(await pg.query("select count(*)::int as n from saved_login_sessions")).toEqual([{ n: 0 }]);

    await row.getByRole("button", { name: "Delete" }).click();
    await row.getByRole("button", { name: "Delete permanently" }).click();
    await expect.poll(() => page.locator("body").innerText(), { timeout: 20000 }).toContain("Login profile deleted");
    expect(await pg.query("select count(*)::int as n from target_login_profiles")).toEqual([{ n: 0 }]);
    expect(problems).toEqual([]);
  });
});
