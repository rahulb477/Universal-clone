import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { authProfiles, crawlJobs, loginProfileCommands, loginSessions, savedLoginSessions, targetLoginProfiles } from "@/db/schema";
import { decryptSecret, decryptSecretBytes, encryptSecret } from "@/lib/crawler/auth";
import { parseLoginInput } from "@/lib/crawler/interactive-login";
import {
  clearSavedSession,
  closeBrowserLogins,
  createSavedProfile,
  deleteSavedProfile,
  getBrowserLogin,
  getSavedProfile,
  invalidateSavedSession,
  listSavedProfiles,
  markSavedProfilesUsed,
  openSavedSessionForWorker,
  ownedSavedProfile,
  profileMatchesUrl,
  resolveSavedProfilesForCrawl,
  saveCapturedSession,
  saveRequestCapture,
  startBrowserLogin,
  updateSavedProfile,
} from "@/lib/server/login-profiles";
import { createCrawl } from "@/lib/server/jobs";
import type { SessionUser } from "@/lib/server/users";
import type { SessionState } from "@/lib/crawler/interactive-login";
import { startAuthSite } from "../fixtures/auth-site";
import { requireChromium } from "../helpers";
import { startPostgres, type TestPostgres } from "../setup/postgres";
import { ENCRYPTION_KEY } from "../setup/server";
import { CrawlWorker } from "@/worker/worker";

/**
 * Saved "Login with Browser" profiles against a real PostgreSQL, a real controlled site and a real
 * Chromium — the whole HTTrack-style workflow, not a mock:
 *
 *   profile → isolated browser → manual sign-in (typed into the live page) → "Use This Login" →
 *   encrypted session → attached to a crawl → authenticated pages in the ZIP.
 *
 * It also covers what must NOT work: another user's profile, another site's cookies, a session that
 * the site has revoked, and a crawl without a worker.
 */

const KEY_BEFORE = process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY;
process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY = ENCRYPTION_KEY;

let pg: TestPostgres;
let site: Awaited<ReturnType<typeof startAuthSite>>;
let worker: CrawlWorker;
let alice: SessionUser;
let bob: SessionUser;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "saved-login-"));
const USER_A = "saved-alice@example.test";
const USER_B = "saved-bob@example.test";
const SITE_USER = "member@example.test";
const SITE_PASSWORD = `pw-${SITE_USER}`;

const user = (id: string, email: string): SessionUser => ({ id, email, role: "user" });
const state = (cookies: Array<{ name: string; domain: string; value?: string }>, origins: string[] = []): SessionState =>
  ({
    cookies: cookies.map((c) => ({ name: c.name, value: c.value ?? "cookie-" + c.name, domain: c.domain, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" })),
    origins: origins.map((origin) => ({ origin, localStorage: [] })),
  }) as unknown as SessionState;

/** The same validation the web tier performs: a real signed-in session of the fixture. */
async function signInToSite(): Promise<SessionState> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: requireChromium(), args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${site.url}/login`);
    await page.fill('input[name="username"]', SITE_USER);
    await page.fill('input[name="password"]', SITE_PASSWORD);
    await page.click("#login");
    await page.waitForSelector(".account[data-authenticated=true]");
    return await ctx.storageState();
  } finally {
    await browser.close();
  }
}

beforeAll(async () => {
  requireChromium();
  pg = await startPostgres();
  await pg.migrate();
  site = await startAuthSite({ rich: true });
  // The web tier writes rows; this worker is what a deployment runs as `npm run worker`.
  process.env.DATABASE_URL = pg.url;
  process.env.CRAWL_DATA_DIR = path.join(dataDir, "work");
  // Keep the archives this test produces inside its own temporary directory.
  process.env.ARCHIVE_DIR = path.join(dataDir, "store");
  process.env.CRAWLER_ALLOW_PRIVATE_NETWORKS = "1";
  worker = new CrawlWorker({ id: "saved-login-worker", pollMs: 150, log: () => {} });
  await worker.start();
  await pg.query("insert into users (id, email, password_hash) values ($1, $2, 'x'), ($3, $4, 'x')", ["alice-id", USER_A, "bob-id", USER_B]);
  alice = user("alice-id", USER_A);
  bob = user("bob-id", USER_B);
}, 180000);

afterAll(async () => {
  await worker?.stop();
  await site?.close();
  await pg?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (KEY_BEFORE === undefined) delete process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY = KEY_BEFORE;
});

afterEach(async () => {
  await db.delete(targetLoginProfiles);
  // The crawl in the end-to-end test may leave a "waiting for sign-in" window behind; jobs are kept.
  await db.delete(loginSessions);
  await db.delete(loginProfileCommands);
});

describe("creating a login profile", () => {
  it("stores only metadata, scoped to the owner and the site", async () => {
    const p = await createSavedProfile(alice, { name: "Member", startUrl: `${site.url}/dashboard`, loginUrl: `${site.url}/login`, authenticatedSelector: ".account[data-authenticated=true]" });
    expect(p).toMatchObject({ name: "Member", targetHost: `127.0.0.1:${new URL(site.url).port}`, status: "login-failed", hasSession: false, session: null });
    const rows = await pg.query<any>("select * from target_login_profiles");
    expect(rows).toHaveLength(1);
    // Nothing secret is stored on creation, and no session row exists yet.
    expect(JSON.stringify(rows[0])).not.toMatch(/cookie|session_state|password/i);
    expect(await pg.query("select * from saved_login_sessions")).toEqual([]);
    expect(await listSavedProfiles(alice)).toHaveLength(1);
    expect(await listSavedProfiles(bob)).toHaveLength(0);
  });

  it("refuses a sign-in page on another site, private/odd addresses, and an over-long name", async () => {
    await expect(createSavedProfile(alice, { name: "x", startUrl: `${site.url}/`, loginUrl: "https://login.example-sso.com/start" })).rejects.toThrow(/must be on/);
    await expect(createSavedProfile(alice, { name: "x", startUrl: "file:///etc/passwd" })).rejects.toThrow(/http/);
    await expect(createSavedProfile(alice, { name: "", startUrl: `${site.url}/` })).rejects.toThrow(/name/);
    await expect(createSavedProfile(alice, { name: "n".repeat(100), startUrl: `${site.url}/` })).rejects.toThrow(/too long/);
  });

  it("is disabled without the encryption key instead of storing a plaintext session", async () => {
    const before = process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY;
    try {
      await expect(createSavedProfile(alice, { name: "x", startUrl: `${site.url}/` })).rejects.toThrow(/CRAWLER_CREDENTIAL_ENCRYPTION_KEY/);
    } finally {
      process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY = before;
    }
  });

  it("renames, and refuses to move a saved login to another site", async () => {
    const p = await createSavedProfile(alice, { name: "Old", startUrl: `${site.url}/dashboard` });
    expect((await updateSavedProfile(alice, p.id, { name: "New name" })).name).toBe("New name");
    await expect(updateSavedProfile(alice, p.id, { startUrl: "https://other.example/" })).rejects.toThrow(/cannot be changed/);
    await expect(updateSavedProfile(alice, p.id, { loginUrl: "https://elsewhere.example/login" })).rejects.toThrow(/must be on/);
  });
});

describe("isolation and ownership", () => {
  it("hides another user's profile behind a 404 and refuses to attach it", async () => {
    const p = await createSavedProfile(alice, { name: "Alice only", startUrl: `${site.url}/dashboard` });
    await expect(ownedSavedProfile(bob, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(getSavedProfile(bob, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateSavedProfile(bob, p.id, { name: "stolen" })).rejects.toMatchObject({ status: 404 });
    await expect(clearSavedSession(bob, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteSavedProfile(bob, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(startBrowserLogin(bob, p.id, {})).rejects.toMatchObject({ status: 404 });
    await expect(resolveSavedProfilesForCrawl(bob, `${site.url}/dashboard`, [p.id])).rejects.toMatchObject({ status: 404 });
    // The owner is unaffected.
    expect((await listSavedProfiles(alice)).map((x) => x.name)).toEqual(["Alice only"]);
  });

  it("never attaches a profile saved for another site", async () => {
    const p = await createSavedProfile(alice, { name: "Site A", startUrl: `${site.url}/dashboard` });
    expect(profileMatchesUrl({ targetHost: `127.0.0.1:${new URL(site.url).port}`, matchSubdomains: false }, `${site.url}/x`)).toBe(true);
    await expect(resolveSavedProfilesForCrawl(alice, "https://example.com/", [p.id])).rejects.toMatchObject({ status: 400 });
    await expect(createCrawl(alice, { url: "https://example.com/", confirmPermission: true, savedProfileIds: [p.id] })).rejects.toThrow(/cannot be used for example\.com/);
    expect(await pg.query("select * from crawl_jobs")).toEqual([]);
  });

  it("keeps the stored session on the profile's own host even when the browser caught more", async () => {
    const p = await createSavedProfile(alice, { name: "Scoped", startUrl: `${site.url}/dashboard` });
    const host = new URL(site.url).hostname;
    // A capture that also carries cookies for unrelated domains (analytics, an identity provider).
    await saveCapturedSession(p.id, alice.id, state([{ name: "sid", domain: host, value: "abc" }, { name: "ga", domain: ".google-analytics.com" }, { name: "sso", domain: "login.identity-provider.test" }], [site.url, "https://login.identity-provider.test"]));
    const stored = (await pg.query<any>("select * from saved_login_sessions"))[0];
    expect(stored.cookie_count).toBe(1); // trimmed before it was encrypted
    const opened = await openSavedSessionForWorker(p.id, alice.id);
    expect(opened!.state.cookies.map((c) => c.name)).toEqual(["sid"]);
    expect(JSON.stringify(opened)).not.toContain("google-analytics");
    expect(JSON.stringify(opened)).not.toContain("identity-provider");
  });
});

describe("the encrypted session at rest", () => {
  it("is stored as an AES-256-GCM envelope bound to profile, owner and host", async () => {
    const p = await createSavedProfile(alice, { name: "Encrypted", startUrl: `${site.url}/dashboard` });
    await saveCapturedSession(p.id, alice.id, state([{ name: "sid", domain: new URL(site.url).hostname, value: "top-secret-cookie-value" }]));
    const row = (await pg.query<any>("select state, expires_at from saved_login_sessions"))[0];
    expect(row.state).toMatch(/^v2\./);
    expect(row.state).not.toContain("top-secret-cookie-value");
    expect(row.state).not.toContain("sid");
    // No API shape contains it either.
    const publicShape = JSON.stringify(await getSavedProfile(alice, p.id));
    expect(publicShape).not.toContain("top-secret-cookie-value");
    expect(publicShape).toContain('"hasSession":true');
    // The worker can decrypt it…
    expect((await openSavedSessionForWorker(p.id, alice.id))!.state.cookies[0].value).toBe("top-secret-cookie-value");
    // …but the envelope cannot be moved to another profile (its additional data includes the id).
    const other = await createSavedProfile(alice, { name: "Other", startUrl: `${site.url}/dashboard` });
    await pg.query("update saved_login_sessions set profile_id = $1 where profile_id = $2", [other.id, p.id]);
    expect(await openSavedSessionForWorker(other.id, alice.id)).toBeNull(); // AAD mismatch → unusable, not guessed
  });

  it("forgets a login without deleting the profile, and marks it as needing a sign-in", async () => {
    const p = await createSavedProfile(alice, { name: "Forget me", startUrl: `${site.url}/dashboard` });
    await saveCapturedSession(p.id, alice.id, state([{ name: "sid", domain: new URL(site.url).hostname }]));
    expect((await getSavedProfile(alice, p.id)).hasSession).toBe(true);
    const after = await clearSavedSession(alice, p.id);
    expect(after).toMatchObject({ hasSession: false, status: "login-failed", name: "Forget me" });
    expect(await pg.query("select * from saved_login_sessions")).toEqual([]);
  });

  it("marks a session the site rejected so the UI offers a new sign-in", async () => {
    const p = await createSavedProfile(alice, { name: "Revoked", startUrl: `${site.url}/dashboard` });
    await saveCapturedSession(p.id, alice.id, state([{ name: "sid", domain: new URL(site.url).hostname }]));
    await invalidateSavedSession(p.id, "expired");
    const profile = await getSavedProfile(alice, p.id);
    expect(profile.status).toBe("session-expired");
    expect(profile.statusLabel).toMatch(/sign in again/i);
    expect(profile.hasSession).toBe(false);
    expect(await openSavedSessionForWorker(p.id, alice.id)).toBeNull();
  });
});

describe("Login with Browser", () => {
  it("opens a real isolated browser, lets the user sign in by hand, and saves the login", async () => {
    const p = await createSavedProfile(alice, { name: "Browser login", startUrl: `${site.url}/dashboard`, loginUrl: `${site.url}/login`, authenticatedSelector: ".account[data-authenticated=true]" });
    const session = await startBrowserLogin(alice, p.id, {});
    expect(session).toMatchObject({ savedProfileId: p.id, status: "awaiting-user" });
    const sb = (sid: string, type: string, payload?: string) => db.insert(loginProfileCommands).values({ sid, savedProfileId: p.id, ownerId: alice.id, type, payload: payload ?? null });
    // Keyboard only: Tab reaches the first field of the fixture form, then the user's own keystrokes
    // fill it in. Nothing about the credentials is known to the crawler.
    const events = [
      { type: "key", key: "Tab" },
      { type: "type", text: SITE_USER },
      { type: "key", key: "Tab" },
      { type: "type", text: SITE_PASSWORD },
      { type: "key", key: "Enter" },
    ];

    try {
      // The worker opened the real sign-in page in its own browser.
      const view = await waitFor(async () => {
        const v = await getBrowserLogin(alice, session.id);
        return v.session.pageUrl?.includes("/login") ? v : null;
      }, 20_000);
      expect(view.session.status).toBe("awaiting-user");
      expect(view.profile.id).toBe(p.id);

      // One screenshot arrives encrypted, and decrypts to a real JPEG for the owner only.
      const frame = await waitFor(async () => (await pg.query<any>("select frame from login_sessions where id = $1", [session.id]))[0]?.frame ?? null, 60_000);
      const jpeg = decryptSecretBytes(frame, `login-frame:${session.id}`);
      expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);

      // "Use This Login" before signing in is refused, and the window stays open for another try.
      await sb(session.id, "confirm");
      await waitFor(async () => {
        const r = await pg.query<any>("select result from login_profile_commands where sid = $1 and type = 'confirm' and processed_at is not null", [session.id]);
        return r[0]?.result === "not authenticated yet" ? r[0] : null;
      }, 20_000);
      expect(await db.select().from(savedLoginSessions)).toEqual([]);
      expect((await getBrowserLogin(alice, session.id)).session.status).toBe("awaiting-user");

      // The user signs in by hand: clicks, typing and a key, through the same encrypted command
      // queue the UI uses.
      for (const event of events) {
        await sb(session.id, "input", encryptSecret(JSON.stringify({ sid: session.id, event: parseLoginInput(event) }), `cmd:login-browser:${session.id}`));
      }

      // The signed-in state is detected automatically and the session is captured.
      await waitFor(async () => {
        const r = await getBrowserLogin(alice, session.id).catch(() => null);
        return r?.session.status === "authenticated" ? r : null;
      }, 90_000);
      const saved = await getSavedProfile(alice, p.id);
      expect(saved.status).toBe("active");
      expect(saved.hasSession).toBe(true);
      expect(saved.session?.cookieCount).toBeGreaterThan(0);
      // The stored envelope holds the site's session, never in the clear.
      const envelope = (await pg.query<any>("select state from saved_login_sessions"))[0].state;
      expect(envelope).toMatch(/^v2\./);
      expect((await openSavedSessionForWorker(p.id, alice.id))!.state.cookies.map((c) => c.name)).toContain("sid");
      // Nothing the user typed survives in the queue, the window rows or the profile rows.
      expect((await pg.query<any>("select payload from login_profile_commands")).every((r) => r.payload === null)).toBe(true);
      const rows = JSON.stringify([await pg.query("select * from login_sessions"), await pg.query("select * from target_login_profiles")]);
      expect(rows).not.toContain(SITE_PASSWORD);
      expect(rows).not.toContain(SITE_USER);
    } finally {
      await closeBrowserLogins(alice, p.id).catch(() => {});
    }
  }, 300_000);

  it("refuses a window to another owner and closes an abandoned one", async () => {
    const p = await createSavedProfile(alice, { name: "Close me", startUrl: `${site.url}/dashboard`, loginUrl: `${site.url}/login` });
    const s = await startBrowserLogin(alice, p.id, {});
    await expect(getBrowserLogin(bob, s.id)).rejects.toMatchObject({ status: 404 });
    expect(await closeBrowserLogins(alice, p.id)).toEqual({ closed: 1 });
    const row = (await pg.query<any>("select status, frame from login_sessions where id = $1", [s.id]))[0];
    expect(row.status).toBe("cancelled");
    expect(row.frame).toBeNull();
  });

  it("refuses a sign-in page outside the profile's site", async () => {
    const p = await createSavedProfile(alice, { name: "Strict", startUrl: `${site.url}/dashboard` });
    await expect(startBrowserLogin(alice, p.id, { entryUrl: "https://example.com/login" })).rejects.toThrow(/must be on/);
    expect(await db.select().from(loginSessions)).toEqual([]);
  });
});

describe("attaching a saved login to a crawl", () => {
  it("crawls authenticated pages with the saved profile and packages them", async () => {
    const p = await createSavedProfile(alice, { name: "Crawl as member", startUrl: `${site.url}/dashboard`, loginUrl: `${site.url}/login`, authenticatedSelector: ".account[data-authenticated=true]" });
    await saveCapturedSession(p.id, alice.id, await signInToSite());
    const loginsBefore = site.stats.loginPosts;

    const created = await createCrawl(alice, {
      url: `${site.url}/dashboard`,
      confirmPermission: true,
      savedProfileIds: [p.id],
      options: { renderMode: "js", useSitemap: false, respectRobots: false, maxDepth: 2, maxPages: 8, delayMs: 0 },
    });
    expect(created.ids).toHaveLength(1);
    expect(created.mode).toBe("authenticated");
    expect(created.attachedProfiles).toEqual(["Crawl as member"]);
    // The per-crawl login points at the reusable profile, and holds no password of its own.
    const perCrawl = (await db.select().from(authProfiles).where(eq(authProfiles.jobId, created.id)))[0];
    expect(perCrawl).toMatchObject({ method: "manual", savedProfileId: p.id });
    expect(perCrawl.secret).toBeTruthy();
    expect(JSON.parse(decryptSecret(perCrawl.secret!, `profile:${perCrawl.id}`))).toMatchObject({ username: "", password: "" });
    // The saved profile records the use.
    const used = await getSavedProfile(alice, p.id);
    expect(used.useCount).toBe(1);
    expect(used.lastUsedAt).not.toBeNull();

    const job = await waitFor(async () => {
      const row = (await db.select().from(crawlJobs).where(eq(crawlJobs.id, created.id)))[0];
      return ["completed", "failed", "cancelled"].includes(row.status) ? row : null;
    }, 180_000);
    expect(job.status).toBe("completed");
    expect(job.hasZip).toBe(true);
    expect(job.storage).toBe("local");
    const zip = new AdmZip(path.join(dataDir, "store", job.storageKey!));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names.some((n) => n.includes("dashboard/index.html"))).toBe(true);
    const dashboard = zip.readAsText(names.find((n) => n.includes("dashboard/index.html"))!);
    expect(dashboard).toContain(`Account ${SITE_USER}`);
    // The crawl never signed in with credentials: the saved session did the work, so the site
    // received no further POST /login beyond the one the user made while saving the profile.
    expect(site.stats.loginPosts).toBe(loginsBefore);
    // With the reusable session attached, the site never saw the fixture's login form again.
    const logs = (await pg.query<any>("select data from job_events where job_id = $1 and type = 'log'", [created.id])).map((r) => r.data.message as string);
    expect(logs.some((m) => m.includes("Restored the saved login profile"))).toBe(true);
    for (const line of logs) expect(line).not.toContain(SITE_PASSWORD);
  }, 300_000);

  it("does not start a crawl it cannot run, and keeps the saved login", async () => {
    const p = await createSavedProfile(alice, { name: "Offline", startUrl: `${site.url}/dashboard` });
    await saveCapturedSession(p.id, alice.id, await signInToSite());
    await pg.query("delete from workers"); // no worker is heart-beating any more
    const created = await createCrawl(alice, { url: `${site.url}/dashboard`, confirmPermission: true, savedProfileIds: [p.id], options: { useSitemap: false, maxDepth: 0 } });
    expect(created.workerOnline).toBe(false);
    // The job is queued honestly ("not started"), and the profile is untouched.
    expect((await db.select().from(crawlJobs).where(eq(crawlJobs.id, created.id)))[0].status).toBe("queued");
    const kept = await getSavedProfile(alice, p.id);
    expect(kept.hasSession).toBe(true);
    expect(kept.status).toBe("active");
  }, 120_000);

  it("still reaches a login that a bot-detection layer blocks, through an imported request", async () => {
    const p = await createSavedProfile(alice, { name: "Imported", startUrl: `${site.url}/dashboard`, loginUrl: `${site.url}/login`, authenticatedSelector: ".account[data-authenticated=true]" });
    const signed = await signInToSite();
    const host = new URL(site.url).hostname;
    const cookie = signed.cookies.find((c) => c.name === "sid")!;
    const captured = await saveRequestCapture(alice, p.id, `curl '${site.url}/dashboard' -H 'cookie: sid=${cookie.value}' --compressed`);
    expect(captured).toMatchObject({ hasSession: true, status: "active" });
    const stored = (await pg.query<any>("select state from saved_login_sessions"))[0];
    expect(stored.state).not.toContain(cookie.value as string);
    const opened = await openSavedSessionForWorker(p.id, alice.id);
    expect(opened!.state.cookies[0]).toMatchObject({ name: "sid", domain: host });
  }, 120_000);
});

describe("housekeeping", () => {
  it("marks profiles used without touching other owners", async () => {
    const a = await createSavedProfile(alice, { name: "A", startUrl: `${site.url}/a` });
    const b = await createSavedProfile(bob, { name: "B", startUrl: `${site.url}/b` });
    await markSavedProfilesUsed([a.id]);
    expect((await getSavedProfile(alice, a.id)).useCount).toBe(1);
    expect((await getSavedProfile(bob, b.id)).useCount).toBe(0);
  });

  it("deletes a profile, its session and the sign-in windows that belonged to it", async () => {
    const p = await createSavedProfile(alice, { name: "Delete me", startUrl: `${site.url}/dashboard` });
    await saveCapturedSession(p.id, alice.id, state([{ name: "sid", domain: new URL(site.url).hostname }]));
    const s = await startBrowserLogin(alice, p.id, {});
    expect((await db.select().from(loginSessions).where(and(eq(loginSessions.id, s.id), eq(loginSessions.ownerId, alice.id)))).length).toBe(1);
    expect(await deleteSavedProfile(alice, p.id)).toEqual({ ok: true, deleted: true });
    expect(await db.select().from(targetLoginProfiles)).toEqual([]);
    expect(await db.select().from(savedLoginSessions)).toEqual([]);
    // The windows of this profile went with it (windows of other profiles/jobs are untouched).
    expect(await db.select().from(loginSessions).where(eq(loginSessions.savedProfileId, p.id))).toEqual([]);
    expect(await db.select().from(loginProfileCommands).where(eq(loginProfileCommands.savedProfileId, p.id))).toEqual([]);
  });
});

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for the login window");
    await new Promise((r) => setTimeout(r, 250));
  }
}
