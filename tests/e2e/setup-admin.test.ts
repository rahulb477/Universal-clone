import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireChromium } from "../helpers";
import { startPostgres, type TestPostgres } from "../setup/postgres";
import { hashPassword } from "@/lib/server/users";
import { bootWeb, signIn, type Web } from "../setup/server";

/**
 * One-time first-administrator setup, driven over HTTP (and in a real browser at an Android
 * viewport) against the production build — `npm run build` must have run first.
 *
 * The `ready` server runs with TRUSTED_PROXY_HOPS=1 like Vercel, so each test can use its own
 * X-Forwarded-For address and the per-client setup rate limit does not leak between tests.
 */

const SETUP_KEY = crypto.randomBytes(36).toString("base64url"); // 48 characters
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uc-setup-"));
const ADMIN_EMAIL = "owner@setup.example.test";
const ADMIN_PASSWORD = "Vh7#quiet-Harbour-92";
const STD_PASSWORD = "correct horse battery staple";

let pg: TestPostgres;
/** ADMIN_SETUP_KEY configured, fresh database. */
let ready: Web;
/** No ADMIN_SETUP_KEY. */
let noKey: Web;
/** ADMIN_SETUP_KEY shorter than 32 characters. */
let weakKey: Web;
/** Database that already holds an administrator (the pre-existing CLI path). */
let hasAdmin: Web;
let browser: Browser;
let ipSeq = 0;
const clientIp = () => `198.51.100.${++ipSeq}`;

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const status = async (base: string) => (await fetch(base + "/api/auth/setup")).json() as Promise<{ setupAvailable: boolean; state: string; message: string }>;
const good = () => ({ setupKey: SETUP_KEY, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, confirmPassword: ADMIN_PASSWORD });
const countUsers = async () => (await pg.query<{ n: number }>("select count(*)::int as n from users"))[0].n;

beforeAll(async () => {
  requireChromium();
  pg = await startPostgres("universal_clone_setup");
  await pg.migrate(pg.url);
  const common = { DATABASE_URL: pg.url, CRAWL_DATA_DIR: DATA_DIR, CRAWLER_WORKER_MODE: "external", AUTH_REGISTRATION: "closed", TRUSTED_PROXY_HOPS: "1" };
  ready = await bootWeb({ ...common, ADMIN_SETUP_KEY: SETUP_KEY });
  noKey = await bootWeb({ ...common, ADMIN_SETUP_KEY: "" });
  weakKey = await bootWeb({ ...common, ADMIN_SETUP_KEY: "too-short-to-be-a-real-secret" });

  const adminDb = await pg.createDatabase("universal_clone_setup_admin");
  await pg.migrate(adminDb);
  await pg.query("insert into users (id, email, password_hash, role) values ('aaaaaaaaaaaa', 'cli@setup.example.test', 'scrypt$32768$8$1$c2FsdA==$aGFzaA==', 'admin')", [], adminDb);
  hasAdmin = await bootWeb({ ...common, DATABASE_URL: adminDb, CRAWL_DATA_DIR: path.join(DATA_DIR, "admin"), ADMIN_SETUP_KEY: SETUP_KEY });

  browser = await chromium.launch({ executablePath: requireChromium(), args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
}, 300000);

afterAll(async () => {
  await browser?.close();
  await Promise.all([ready?.stop(), noKey?.stop(), weakKey?.stop(), hasAdmin?.stop()]);
  await pg?.stop();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("setup availability is decided on the server", () => {
  it("is disabled when ADMIN_SETUP_KEY is missing, and the page says so", async () => {
    expect(await status(noKey.base)).toMatchObject({ setupAvailable: false, state: "not-configured" });
    const html = await (await fetch(noKey.base + "/setup-admin")).text();
    expect(html).toContain("Setup is not available");
    expect(html).not.toContain("Create the first administrator");
    expect((await post(noKey.base, good())).status).toBe(503);
  });

  it("is disabled when ADMIN_SETUP_KEY is shorter than 32 characters", async () => {
    expect(await status(weakKey.base)).toMatchObject({ setupAvailable: false, state: "key-too-weak" });
    expect((await post(weakKey.base, { ...good(), setupKey: "too-short-to-be-a-real-secret" })).status).toBe(503);
  });

  it("is disabled when an administrator already exists", async () => {
    expect(await status(hasAdmin.base)).toMatchObject({ setupAvailable: false, state: "completed" });
    expect((await post(hasAdmin.base, good())).status).toBe(409);
    const html = await (await fetch(hasAdmin.base + "/setup-admin")).text();
    expect(html).toContain("Setup is not available");
    expect(html).toContain("already complete");
  });

  it("is available on a fresh database with a valid key", async () => {
    expect(await status(ready.base)).toMatchObject({ setupAvailable: true, state: "available" });
    const html = await (await fetch(ready.base + "/setup-admin")).text();
    expect(html).toContain("Create the first administrator");
    for (const id of ["setup-email", "setup-password", "setup-confirm", "setup-key"]) expect(html, id).toContain(`id="${id}"`);
    // No secrets in the payload, not even a prefix of the key.
    expect(html).not.toContain(SETUP_KEY);
    expect(html).not.toContain(SETUP_KEY.slice(0, 12));
    expect(await (await fetch(ready.base + "/api/auth/setup")).text()).not.toContain(SETUP_KEY.slice(0, 12));
  });
});

describe("the setup page in an Android browser", () => {
  it("loads, lays out without horizontal overflow, and toggles the password fields", async () => {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36" });
    const page: Page = await context.newPage();
    const problems: string[] = [];
    // The deliberately rejected request below is the only expected console entry.
    page.on("console", (m) => m.type() === "error" && !/status of 403/.test(m.text()) && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(e.message));

    await page.goto(ready.base + "/setup-admin");
    await page.getByRole("heading", { name: "Create the first administrator" }).waitFor();
    expect(await page.title()).toContain("Universal Clone");
    // The page fits the phone: no sideways scrolling.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // All controls are comfortably tappable (>= 40 px tall) and visible.
    for (const id of ["setup-email", "setup-password", "setup-confirm", "setup-key"]) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.height, id).toBeGreaterThanOrEqual(36);
      expect(box!.width, id).toBeGreaterThan(180);
    }
    // Show/hide works on all three secret fields.
    for (const [id, label] of [["setup-password", "Password"], ["setup-confirm", "Confirm password"], ["setup-key", "Setup key"]] as const) {
      const field = page.locator(`#${id}`);
      expect(await field.getAttribute("type")).toBe("password");
      const row = page.locator(`#${id}`).locator("xpath=..");
      await row.getByRole("button", { name: "Show" }).click();
      expect(await field.getAttribute("type")).toBe("text");
      await row.getByRole("button", { name: "Hide" }).click();
      expect(await field.getAttribute("type")).toBe("password");
      expect(label.length).toBeGreaterThan(0);
    }
    // Client-side hints appear while typing, and a mismatch is flagged before submitting.
    await page.fill("#setup-email", "someone@example.test");
    await page.fill("#setup-password", "short");
    await page.getByText(/at least 12 characters/i).waitFor();
    await page.fill("#setup-password", "Vh7#quiet-Harbour-92");
    await page.getByText("Strong password.").waitFor();
    await page.fill("#setup-confirm", "something-else");
    await page.getByText("The passwords do not match.").waitFor();
    // Submitting an empty form shows an inline alert rather than navigating away.
    await page.getByRole("button", { name: "Create administrator" }).click();
    await page.locator("p[role=alert]").waitFor();
    expect(await page.locator("p[role=alert]").innerText()).toMatch(/password/i);
    // …and with everything filled but a wrong key, the server's answer is shown and the key field is cleared.
    await page.fill("#setup-email", "someone@example.test");
    await page.fill("#setup-password", "Vh7#quiet-Harbour-92");
    await page.fill("#setup-confirm", "Vh7#quiet-Harbour-92");
    await page.fill("#setup-key", "not-the-right-key-" + "z".repeat(30));
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect.poll(() => page.locator("p[role=alert]").innerText()).toMatch(/setup key/i);
    expect(await page.locator("#setup-key").inputValue()).toBe("");
    await page.screenshot({ path: path.join(DATA_DIR, "setup-admin-mobile.png"), fullPage: true });
    expect(problems, problems.join(" | ")).toEqual([]);
    await context.close();
  }, 120000);
});

describe("validation and cross-site protection", () => {
  it("rejects a wrong setup key with 403 and creates nothing", async () => {
    const r = await post(ready.base, { ...good(), setupKey: crypto.randomBytes(36).toString("base64url") }, { "x-forwarded-for": clientIp() });
    expect(r.status).toBe(403);
    const body = await r.text();
    expect(body).toMatch(/setup key/i);
    expect(body).not.toContain(SETUP_KEY.slice(0, 12));
    expect(await pg.query("select count(*)::int as n from users where email = $1", [ADMIN_EMAIL])).toEqual([{ n: 0 }]);
  });

  it("rejects an invalid email with 400", async () => {
    for (const email of ["not-an-email", "a@b", "x y@example.com", "", 42]) {
      const r = await post(ready.base, { ...good(), email }, { "x-forwarded-for": clientIp() });
      expect(r.status, String(email)).toBe(400);
      expect((await r.json()).error).toMatch(/email/i);
    }
    expect(await countUsers()).toBe(0);
  });

  it("rejects weak passwords with 400 and an explicit policy message", async () => {
    for (const password of ["short1!A", "abcdefghijklm", "12345678901234", "abcdefghijkl1", "ABCdefghijkl"]) {
      const r = await post(ready.base, { ...good(), password, confirmPassword: password }, { "x-forwarded-for": clientIp() });
      expect(r.status, password).toBe(400);
      expect((await r.json()).error).toMatch(/stronger password/i);
    }
    const withEmail = await post(ready.base, { ...good(), password: "owner-Str0ng-pass", confirmPassword: "owner-Str0ng-pass" }, { "x-forwarded-for": clientIp() });
    expect(withEmail.status).toBe(400);
    expect(await countUsers()).toBe(0);
  });

  it("rejects a mismatched password confirmation with 400", async () => {
    const ip = clientIp();
    const r = await post(ready.base, { ...good(), confirmPassword: ADMIN_PASSWORD + "x" }, { "x-forwarded-for": ip });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/confirmation does not match/i);
    expect((await post(ready.base, { ...good(), confirmPassword: undefined }, { "x-forwarded-for": clientIp() })).status).toBe(400);
    expect(await countUsers()).toBe(0);
  });

  it("rejects cross-origin, cross-site, form-encoded and non-JSON requests", async () => {
    const body = good();
    expect((await post(ready.base, body, { origin: "https://evil.example", "x-forwarded-for": clientIp() })).status).toBe(403);
    expect((await post(ready.base, body, { "sec-fetch-site": "cross-site", "x-forwarded-for": clientIp() })).status).toBe(403);
    const form = await fetch(ready.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": clientIp() }, body: "email=x" });
    expect(form.status).toBe(415);
    expect((await post(ready.base, "email=x", { "x-forwarded-for": clientIp() })).status).toBe(400);
    expect(await countUsers()).toBe(0);
  });

  it("rate-limits repeated attempts from one client", async () => {
    const ip = clientIp();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await post(ready.base, { ...good(), setupKey: `guess-${i}-` + "y".repeat(40) }, { "x-forwarded-for": ip })).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes[0]).toBe(403); // the first attempts are answered normally
    // Once limited, even a correct key is refused from that client.
    expect((await post(ready.base, good(), { "x-forwarded-for": ip })).status).toBe(429);
  });
});

describe("first administrator creation and integration with the existing auth", () => {
  it("creates the administrator exactly once, storing a scrypt hash", async () => {
    expect(await countUsers()).toBe(0);
    const r = await post(ready.base, good(), { "x-forwarded-for": clientIp() });
    expect(r.status, await r.clone().text()).toBe(201);
    expect((await r.json()).user).toEqual({ email: ADMIN_EMAIL, role: "admin" });

    const rows = await pg.query<{ id: string; email: string; role: string; password_hash: string }>("select id, email, role, password_hash from users");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: ADMIN_EMAIL, role: "admin" });
    expect(rows[0].password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(rows[0].password_hash).not.toContain(ADMIN_PASSWORD);
    expect(JSON.stringify(rows)).not.toContain(SETUP_KEY);
    expect(await pg.query("select id from admin_setup")).toEqual([{ id: "first-admin" }]);
  });

  it("is disabled immediately afterwards; a second setup returns 409 and creates nothing", async () => {
    expect(await status(ready.base)).toMatchObject({ setupAvailable: false, state: "completed" });
    const r = await post(ready.base, { ...good(), email: "second@setup.example.test" }, { "x-forwarded-for": clientIp() });
    expect(r.status).toBe(409);
    // Same email → still 409 (setup is over, not just a duplicate).
    expect((await post(ready.base, good(), { "x-forwarded-for": clientIp() })).status).toBe(409);
    const admins = await pg.query<{ n: number }>("select count(*)::int as n from users where role = 'admin'");
    expect(admins[0].n).toBe(1);
  });

  it("rejects two simultaneous submissions at most one of which wins (advisory lock)", async () => {
    // A fresh database so setup is available again; two requests race each other.
    const raceDb = await pg.createDatabase("universal_clone_setup_race");
    await pg.migrate(raceDb);
    const race = await bootWeb({ DATABASE_URL: raceDb, CRAWL_DATA_DIR: path.join(DATA_DIR, "race"), CRAWLER_WORKER_MODE: "external", ADMIN_SETUP_KEY: SETUP_KEY, TRUSTED_PROXY_HOPS: "1" });
    try {
      const [a, b] = await Promise.all([
        post(race.base, { ...good(), email: "race-a@setup.example.test" }, { "x-forwarded-for": clientIp() }),
        post(race.base, { ...good(), email: "race-b@setup.example.test" }, { "x-forwarded-for": clientIp() }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await pg.query("select count(*)::int as n from users", [], raceDb)).toEqual([{ n: 1 }]);
    } finally {
      await race.stop();
    }
  });

  it("signs the new administrator in with the existing login endpoint", async () => {
    const admin = await signIn(ready.base, ADMIN_EMAIL, ADMIN_PASSWORD);
    const me = await admin.json("/api/auth/me");
    expect(me.user).toEqual({ email: ADMIN_EMAIL, role: "admin" });

    // Administrator-only route accepts the account…
    const overview = await admin.get("/api/admin/overview");
    expect(overview.status).toBe(200);
    const data = await overview.json();
    expect(data.viewer).toMatchObject({ email: ADMIN_EMAIL, role: "admin" });
    expect(data.counts.admins).toBe(1);
    expect(JSON.stringify(data)).not.toContain("password_hash");
    expect(JSON.stringify(data)).not.toContain(SETUP_KEY);

    // …and the normal application keeps working for the administrator.
    expect((await admin.get("/api/crawl")).status).toBe(200);
  });

  it("keeps the existing user role working, and admin routes closed to it", async () => {
    // A pre-existing ordinary account, hashed exactly like the CLI tool would have stored it.
    await pg.query("insert into users (id, email, password_hash, role) values ($1, $2, $3, 'user')", ["cccccccccccc", "plain@setup.example.test", await hashPassword(STD_PASSWORD)]);
    const user = await signIn(ready.base, "plain@setup.example.test", STD_PASSWORD);
    expect((await user.json("/api/auth/me")).user).toEqual({ email: "plain@setup.example.test", role: "user" });
    expect((await user.get("/api/crawl")).status).toBe(200);
    expect((await user.get("/api/admin/overview")).status).toBe(403);
    // Anonymous visitors are refused before the role is looked at.
    expect((await fetch(ready.base + "/api/admin/overview")).status).toBe(401);
  });

  it("rejects a duplicate email when the account exists but no admin does", async () => {
    const dupDb = await pg.createDatabase("universal_clone_setup_dup");
    await pg.migrate(dupDb);
    await pg.query("insert into users (id, email, password_hash, role) values ('bbbbbbbbbbbb', 'taken@setup.example.test', 'scrypt$32768$8$1$c2FsdA==$aGFzaA==', 'user')", [], dupDb);
    const dup = await bootWeb({ DATABASE_URL: dupDb, CRAWL_DATA_DIR: path.join(DATA_DIR, "dup"), CRAWLER_WORKER_MODE: "external", ADMIN_SETUP_KEY: SETUP_KEY, TRUSTED_PROXY_HOPS: "1" });
    try {
      const r = await post(dup.base, { ...good(), email: "TAKEN@setup.example.test" }, { "x-forwarded-for": clientIp() });
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/already exists/i);
      // Setup is still available, and a different address succeeds.
      expect(await status(dup.base)).toMatchObject({ setupAvailable: true });
      expect((await post(dup.base, { ...good(), email: "fresh@setup.example.test" }, { "x-forwarded-for": clientIp() })).status).toBe(201);
      expect(await pg.query("select count(*)::int as n from users", [], dupDb)).toEqual([{ n: 2 }]);
    } finally {
      await dup.stop();
    }
  });

  it("keeps first-admin setup disabled even if the administrator account is deleted", async () => {
    const goneDb = await pg.createDatabase("universal_clone_setup_gone");
    await pg.migrate(goneDb);
    const gone = await bootWeb({ DATABASE_URL: goneDb, CRAWL_DATA_DIR: path.join(DATA_DIR, "gone"), CRAWLER_WORKER_MODE: "external", ADMIN_SETUP_KEY: SETUP_KEY, TRUSTED_PROXY_HOPS: "1" });
    try {
      expect((await post(gone.base, good(), { "x-forwarded-for": clientIp() })).status).toBe(201);
      await pg.query("delete from users", [], goneDb);
      // The marker row survives (user_id is nulled, no cascade).
      expect(await pg.query("select user_id from admin_setup", [], goneDb)).toEqual([{ user_id: null }]);
      expect(await status(gone.base)).toMatchObject({ setupAvailable: false, state: "completed" });
      expect((await post(gone.base, good(), { "x-forwarded-for": clientIp() })).status).toBe(409);
    } finally {
      await gone.stop();
    }
  });

  it("does not print the setup key or the password in the server log", async () => {
    const output = [ready, noKey, weakKey, hasAdmin].map((w) => w.output()).join("\n");
    expect(output).not.toContain(SETUP_KEY);
    expect(output).not.toContain(SETUP_KEY.slice(0, 12));
    expect(output).not.toContain(ADMIN_PASSWORD);
  });
});
