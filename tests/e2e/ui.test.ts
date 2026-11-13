import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAuthSite } from "../fixtures/auth-site";
import { requireChromium } from "../helpers";
import { startPostgres, type TestPostgres } from "../setup/postgres";
import { bootWeb, type Web } from "../setup/server";

/**
 * Drives the real web UI in a real browser against the production build (`npm run build` first):
 * create an account, sign in, configure a login profile, answer the site's verification step in the
 * remote sign-in panel, watch the crawl finish, download the ZIP, delete the job, sign out.
 */

let pg: TestPostgres;
let site: Awaited<ReturnType<typeof startAuthSite>>;
let web: Web;
let browser: Browser;
let page: Page;
const problems: string[] = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-ui-"));
const EMAIL = "ui-user@example.test";
const PASSWORD = "a password for the ui test";
const SITE_USER = "mfa-ui@example.test";
const SITE_PASSWORD = `pw-${SITE_USER}`;

const field = (title: string) => page.locator("fieldset div").filter({ has: page.locator(`label:text-is("${title}")`) }).last().locator("input");

beforeAll(async () => {
  const executablePath = requireChromium();
  pg = await startPostgres();
  await pg.migrate(pg.url);
  site = await startAuthSite({ rich: true });
  web = await bootWeb({ DATABASE_URL: pg.url, CRAWL_DATA_DIR: dataDir, CRAWLER_WORKER_MODE: "inline", CRAWLER_ALLOW_PRIVATE_NETWORKS: "1", AUTH_REGISTRATION: "open", CRAWLER_STARTS_PER_MINUTE: "100" });
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
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
  await pg?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("web UI in a real browser", () => {
  it("shows only the sign-in form to a visitor, without errors", async () => {
    await page.goto(web.base + "/");
    await expect.poll(() => page.locator("h1").innerText()).toBe("Universal Clone");
    expect(await page.title()).toContain("Universal Clone");
    expect(await page.locator("input[aria-label='Website URL']").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Start download" }).count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it("rejects a wrong password, creates an account, and signs in", async () => {
    await page.fill("#acc-email", "nobody@example.test");
    await page.fill("#acc-password", "definitely wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.poll(() => page.locator("p[role=alert]").innerText()).toMatch(/incorrect|invalid/i);
    problems.length = 0; // the 401 above is the expected console entry

    await page.getByRole("button", { name: "Create an account" }).click();
    await page.fill("#acc-email", EMAIL);
    await page.fill("#acc-password", PASSWORD);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.getByText("Account created. Sign in to continue.").waitFor();
    await page.fill("#acc-password", PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("input[aria-label='Website URL']").waitFor();
    expect(await page.locator("header, main, body").first().innerText()).toContain(EMAIL);
    // The session cookie is not readable by scripts.
    expect(await page.evaluate(() => document.cookie)).not.toContain("uc_session");
    const cookie = (await page.context().cookies()).find((c) => c.name === "uc_session")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    expect(problems).toEqual([]);
  });

  it("refuses to start without the permission confirmation", async () => {
    await page.fill("input[aria-label='Website URL']", `${site.url}/dashboard`);
    await page.getByRole("button", { name: "Start download" }).click();
    await expect.poll(() => page.locator("p[role=alert]").innerText()).toMatch(/permission|confirm/i);
    expect(await pg.query("select count(*)::int as n from crawl_jobs")).toEqual([{ n: 0 }]);
  });

  it("runs an authenticated crawl: profile form → verification step answered in the remote sign-in panel → live progress → ZIP download", async () => {
    // Step 2 offers a saved login ("Login with Browser") and a login entered here; this test uses the latter.
    await page.getByRole("button", { name: "Login with Browser" }).click();
    await page.getByRole("tab", { name: "Login entered here" }).click();
    await page.getByRole("button", { name: "+ Add Login" }).click();
    await field("Profile Name").fill("Member");
    await field("Login Page URL").fill(`${site.url}/login`);
    await field("Email / Username").fill(SITE_USER);
    await field("Password").fill(SITE_PASSWORD);
    await field("Authenticated-state selector (required for verification)").fill(".account[data-authenticated=true]");
    await field("MFA / verification page selector (optional)").fill("#otp-form");
    expect(await field("Password").getAttribute("type")).toBe("password");
    await page.getByLabel(/I own this website or have permission/).check();
    await page.getByRole("button", { name: "Start download" }).click();

    // The password leaves the page as soon as the crawl is created.
    await page.getByRole("heading", { name: "Live crawl" }).waitFor();
    expect(await field("Password").inputValue()).toBe("");
    expect(await page.content()).not.toContain(SITE_PASSWORD);

    // The site asks for a one-time code: the crawl waits and the panel shows the isolated browser.
    const panel = page.locator("section[aria-label='Manual sign-in']");
    await panel.waitFor({ timeout: 60000 });
    expect(await panel.locator("h2").innerText()).toBe("Verification step required — Member");
    await panel.locator("img").waitFor({ timeout: 30000 });
    await expect.poll(() => panel.innerText(), { timeout: 15000 }).toContain(`${site.url}/mfa`);
    await page.getByText("Waiting for you to sign in / verify").waitFor();
    // The crawl is waiting for a person, and says so; there is nothing to "resume" yet.
    const liveNow = page.locator("section").filter({ has: page.getByRole("heading", { name: "Live crawl" }) });
    await expect.poll(() => liveNow.innerText()).toContain("waiting for sign-in");
    expect(await liveNow.getByRole("button", { name: "Resume" }).count()).toBe(0);
    expect(await liveNow.getByRole("button", { name: "Cancel" }).count()).toBe(1);
    expect(site.stats.mfaPosts).toBe(0);
    await page.screenshot({ path: path.join(dataDir, "login-panel.png") });

    // The frame is a real screenshot of the verification page (not a blank image).
    const dims = await panel.locator("img").evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, h: img.naturalHeight }));
    expect(dims).toEqual({ w: 1280, h: 800 });

    // A wrong code first, typed on the keyboard into the remote page; the site rejects it and the crawl keeps waiting.
    await panel.locator("img").focus();
    await page.keyboard.type("000000");
    await page.keyboard.press("Enter");
    await expect.poll(() => site.stats.mfaPosts, { timeout: 30000 }).toBe(1);
    expect(await panel.isVisible()).toBe(true);
    // Then the right one through the text box.
    await panel.locator("input[type=password]").fill("123456");
    await panel.getByRole("button", { name: "Send text" }).click();
    await panel.getByRole("button", { name: "Enter", exact: true }).click();
    await expect.poll(() => site.stats.mfaPosts, { timeout: 30000 }).toBe(2);
    await panel.waitFor({ state: "detached", timeout: 60000 });

    // Live progress, then completion.
    const live = page.locator("section").filter({ has: page.getByRole("heading", { name: "Live crawl" }) });
    await expect.poll(() => live.innerText(), { timeout: 120000, interval: 500 }).toContain("completed");
    const link = page.getByRole("link", { name: /Download ZIP/ });
    await link.waitFor({ timeout: 30000 });
    expect(await page.locator("[role=progressbar]").getAttribute("aria-valuenow")).toBe("100");
    expect(await live.innerText()).toMatch(/Activity log/);
    expect(await live.innerText()).toContain("Login state verified");
    expect(await page.getByText("Completed", { exact: true }).count()).toBeGreaterThan(0);

    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    const file = path.join(dataDir, "ui-download.zip");
    await download.saveAs(file);
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const zip = new AdmZip(file);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("dashboard/index.html");
    expect(zip.readAsText("dashboard/index.html")).toContain(`Account ${SITE_USER}`);
    // Nothing secret anywhere: not in the archive, the page, or the server's output.
    for (const e of zip.getEntries()) expect(e.getData().includes(SITE_PASSWORD), e.entryName).toBe(false);
    expect(await page.content()).not.toContain(SITE_PASSWORD);
    expect(web.output()).not.toContain(SITE_PASSWORD);
    expect(site.stats.loginPosts).toBe(1);
    const row = (await pg.query<any>("select secret, session_state, cleared_at from auth_profiles"))[0];
    expect(row).toMatchObject({ secret: null, session_state: null });
    expect(row.cleared_at).not.toBeNull();
    expect(problems).toEqual([]);
  }, 300000);

  it("keeps the session and the history across a reload; reports open; delete removes the job", async () => {
    await page.reload();
    await page.getByRole("heading", { name: "Download history" }).waitFor();
    const history = page.locator("section").filter({ has: page.getByRole("heading", { name: "Download history" }) });
    await expect.poll(() => history.innerText()).toContain(`${site.url}/dashboard`);
    expect(await history.innerText()).toContain("completed");

    await history.getByRole("button", { name: "Open" }).click();
    const report = page.getByRole("link", { name: "crawl-report.json" });
    await report.waitFor();
    const res = await page.request.get(web.base + (await report.getAttribute("href")));
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.stats.status).toBe("completed");
    expect(JSON.stringify(json)).not.toContain(SITE_PASSWORD);

    await history.getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => history.innerText()).not.toContain(`${site.url}/dashboard`);
    expect(await pg.query("select count(*)::int as n from crawl_jobs")).toEqual([{ n: 0 }]);
    expect(problems).toEqual([]);
  });

  it("signs out: the downloader disappears and the API refuses the old session", async () => {
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.locator("#acc-email").waitFor();
    expect(await page.locator("input[aria-label='Website URL']").count()).toBe(0);
    expect((await page.request.get(web.base + "/api/crawl")).status()).toBe(401);
    expect(await pg.query("select count(*)::int as n from user_sessions")).toEqual([{ n: 0 }]);
  });
});

describe("embedding (APP_EMBED_ORIGINS)", () => {
  it("default deployment forbids framing; an allow-listed origin may frame it and gets a partitioned cookie", async () => {
    const plain = await fetch(web.base + "/");
    expect(plain.headers.get("x-frame-options")).toBe("DENY");
    expect(plain.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const embedded = await bootWeb({ DATABASE_URL: pg.url, CRAWL_DATA_DIR: dataDir, CRAWLER_WORKER_MODE: "external", APP_EMBED_ORIGINS: "https://portal.example.com, javascript:alert(1), not-a-url", AUTH_COOKIE_SECURE: "1" });
    try {
      const r = await fetch(embedded.base + "/");
      expect(r.headers.get("x-frame-options")).toBeNull();
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors https://portal.example.com;");
      expect(r.headers.get("content-security-policy")).not.toMatch(/javascript|not-a-url/);
      const login = await fetch(embedded.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: embedded.base }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/^__Host-uc_session=/);
      for (const attr of ["HttpOnly", "Secure", "SameSite=None", "Partitioned", "Path=/"]) expect(cookie).toContain(attr);
    } finally {
      await embedded.stop();
    }
  }, 120000);
});
