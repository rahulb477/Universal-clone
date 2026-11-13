import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAuthSite } from "../fixtures/auth-site";
import { startExternal, startFixture, type Fixture } from "../fixtures/site";
import { requireChromium } from "../helpers";
import { startPostgres, type TestPostgres } from "../setup/postgres";
import { bootWeb, readSse, runCli, signIn, waitFor, type Client, type Web } from "../setup/server";

/**
 * Boots the real production server (`next start`, requires a prior `npm run build`) against a real
 * PostgreSQL server and drives it over HTTP + Server-Sent Events, exactly like the browser UI does.
 * The server runs the crawl worker in-process ("inline" mode); tests/e2e/worker.test.ts covers the
 * separate worker process.
 */

let pg: TestPostgres;
let fx: Fixture;
let ext: Awaited<ReturnType<typeof startExternal>>;
let auth: Awaited<ReturnType<typeof startAuthSite>>;
let open: Web;
let strict: Web;
let alice: Client;
let bob: Client;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-api-"));
const PASSWORD = "correct horse battery staple";
const INVITE = "invite-code-for-tests-0001";

const start = (c: Client, body: Record<string, unknown>) => c.post("/api/crawl", { confirmPermission: true, ...body });
const done = (base: string, c: Client, id: string, timeoutMs = 90000) => readSse(`${base}/api/crawl/${id}/events`, c.cookie, (e) => e.type === "done", timeoutMs);

beforeAll(async () => {
  requireChromium();
  pg = await startPostgres();
  // Schema and accounts are created with the same command-line tools an operator uses.
  const m = runCli("src/db/migrate.ts", [], { DATABASE_URL: pg.url });
  expect(m.out).toContain("migrations applied: 0000_initial.sql, 0001_users_ownership_queue.sql");
  for (const email of ["alice@owner.test", "bob@owner.test"]) {
    const r = runCli("scripts/create-user.ts", [email], { DATABASE_URL: pg.url, USER_PASSWORD: PASSWORD });
    expect(r.code, r.out).toBe(0);
  }
  ext = await startExternal();
  fx = await startFixture(ext.url);
  auth = await startAuthSite({ rich: true });
  const common = { DATABASE_URL: pg.url, CRAWL_DATA_DIR: dataDir, CRAWLER_STARTS_PER_MINUTE: "100", CRAWLER_WORKER_MODE: "inline" };
  // `open` is the operator-configured instance allowed to reach private addresses (needed to crawl the local fixtures).
  open = await bootWeb({ ...common, CRAWLER_ALLOW_PRIVATE_NETWORKS: "1", AUTH_REGISTRATION: "invite", AUTH_INVITE_CODE: INVITE, CRAWLER_MAX_ACTIVE_JOBS_PER_USER: "3" });
  // `strict` is a default deployment. It has its own database: every worker on one queue must share one network policy.
  const strictDb = await pg.createDatabase("universal_clone_strict");
  await pg.migrate(strictDb);
  expect(runCli("scripts/create-user.ts", ["alice@owner.test"], { DATABASE_URL: strictDb, USER_PASSWORD: PASSWORD }).code).toBe(0);
  strict = await bootWeb({ ...common, DATABASE_URL: strictDb, CRAWL_DATA_DIR: path.join(dataDir, "strict") });
  alice = await signIn(open.base, "alice@owner.test", PASSWORD);
  bob = await signIn(open.base, "bob@owner.test", PASSWORD);
}, 180000);

afterAll(async () => {
  await open?.stop();
  await strict?.stop();
  await fx?.close();
  await ext?.close();
  await auth?.close();
  await pg?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("accounts and sessions", () => {
  it("serves the app shell with security headers", async () => {
    const r = await fetch(open.base + "/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>Universal Clone");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("every crawl endpoint requires a signed-in user", async () => {
    const id = "0123456789abcdef";
    for (const p of ["/api/crawl", `/api/crawl/${id}`, `/api/crawl/${id}/events`, `/api/crawl/${id}/download`, `/api/crawl/${id}/report/crawl-report.json`, `/api/crawl/${id}/auth`, `/api/crawl/${id}/login`, `/api/crawl/${id}/login/abc/frame`]) {
      const r = await fetch(open.base + p);
      expect(r.status, p).toBe(401);
    }
    const post = await fetch(open.base + "/api/crawl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: fx.url, confirmPermission: true }) });
    expect(post.status).toBe(401);
    expect((await fetch(`${open.base}/api/crawl/${id}/control`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${open.base}/api/crawl/${id}`, { method: "DELETE" })).status).toBe(401);
    // The session bootstrap answers anonymous visitors without revealing anything.
    const me = await fetch(open.base + "/api/auth/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user: null, registration: "invite" });
    // A made-up cookie is not a session.
    expect((await fetch(open.base + "/api/crawl", { headers: { cookie: "uc_session=" + "A".repeat(43) } })).status).toBe(401);
  });

  it("the session cookie is HttpOnly + SameSite and only its hash is stored", async () => {
    const r = await fetch(open.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ALICE@owner.test", password: PASSWORD }) });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^uc_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Expires=/);
    const token = cookie.split(";")[0].split("=")[1];
    const rows = await pg.query<{ id: string }>("select id from user_sessions");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((s) => s.id === token)).toBe(false);
    const hashes = await pg.query<{ password_hash: string }>("select password_hash from users");
    expect(hashes.every((h) => /^scrypt\$/.test(h.password_hash) && !h.password_hash.includes(PASSWORD))).toBe(true);
    const me = await (await fetch(open.base + "/api/auth/me", { headers: { cookie: cookie.split(";")[0] } })).json();
    expect(me.user).toEqual({ email: "alice@owner.test", role: "user" });
    expect(me.features).toMatchObject({ authenticatedCrawling: true, workerMode: "inline", workerOnline: true });
  });

  it("rejects wrong passwords and unknown accounts with the same answer, and rate-limits guessing", async () => {
    const attempt = (email: string, password: string) => fetch(open.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const wrong = await attempt("bob@owner.test", "not-the-password");
    const unknown = await attempt("nobody@owner.test", "not-the-password");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    let limited = 0;
    for (let i = 0; i < 12; i++) if ((await attempt("victim@owner.test", "guess-" + i)).status === 429) limited++;
    expect(limited).toBeGreaterThanOrEqual(2);
  });

  it("registration: closed by default, invite code required when configured, passwords validated", async () => {
    const reg = (base: string, body: unknown) => fetch(base + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await reg(strict.base, { email: "new@owner.test", password: PASSWORD })).status).toBe(403);
    expect((await reg(open.base, { email: "new@owner.test", password: PASSWORD })).status).toBe(403);
    expect((await reg(open.base, { email: "new@owner.test", password: PASSWORD, inviteCode: "wrong" })).status).toBe(403);
    expect((await reg(open.base, { email: "new@owner.test", password: "short", inviteCode: INVITE })).status).toBe(400);
    expect((await reg(open.base, { email: "not-an-email", password: PASSWORD, inviteCode: INVITE })).status).toBe(400);
    expect((await reg(open.base, { email: "new@owner.test", password: PASSWORD, inviteCode: INVITE })).status).toBe(201);
    expect((await reg(open.base, { email: "New@Owner.test", password: PASSWORD, inviteCode: INVITE })).status).toBe(409);
    const fresh = await signIn(open.base, "new@owner.test", PASSWORD);
    expect((await fresh.json("/api/crawl")).jobs).toEqual([]);
  });

  it("CSRF: state-changing requests need the token and a same-origin request", async () => {
    const body = JSON.stringify({ url: fx.url, confirmPermission: true });
    const base = { cookie: alice.cookie, "content-type": "application/json" };
    const noToken = await fetch(open.base + "/api/crawl", { method: "POST", headers: base, body });
    expect(noToken.status).toBe(403);
    const wrongToken = await fetch(open.base + "/api/crawl", { method: "POST", headers: { ...base, "x-csrf-token": bob.csrf }, body });
    expect(wrongToken.status).toBe(403);
    const crossOrigin = await fetch(open.base + "/api/crawl", { method: "POST", headers: { ...base, "x-csrf-token": alice.csrf, origin: "https://evil.example" }, body });
    expect(crossOrigin.status).toBe(403);
    const crossSite = await fetch(open.base + "/api/crawl", { method: "POST", headers: { ...base, "x-csrf-token": alice.csrf, "sec-fetch-site": "cross-site" }, body });
    expect(crossSite.status).toBe(403);
    expect((await fetch(open.base + "/api/auth/logout", { method: "POST", headers: { cookie: alice.cookie } })).status).toBe(403);
    expect((await alice.json("/api/crawl")).jobs).toEqual([]);
  });

  it("logout ends the session on the server", async () => {
    const c = await signIn(open.base, "bob@owner.test", PASSWORD);
    expect((await c.json("/api/auth/me")).user.email).toBe("bob@owner.test");
    const out = await c.post("/api/auth/logout");
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await c.json("/api/auth/me")).user).toBeNull();
    expect((await c.get("/api/crawl")).status).toBe(401);
  });
});

describe("crawl API", () => {
  it("requires the permission confirmation and a URL", async () => {
    expect((await alice.post("/api/crawl", { url: fx.url })).status).toBe(400);
    expect((await alice.post("/api/crawl", { confirmPermission: true })).status).toBe(400);
    const bad = await fetch(open.base + "/api/crawl", { method: "POST", headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf }, body: "not json" });
    expect(bad.status).toBe(400);
  });

  it("the default (strict) server rejects private / metadata / non-http targets", async () => {
    const c = await signIn(strict.base, "alice@owner.test", PASSWORD);
    for (const url of [fx.url, "http://localhost:3000", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "file:///etc/passwd", "http://10.0.0.1"]) {
      const r = await start(c, { url });
      expect(r.status, url).toBe(400);
      expect((await r.json()).error).toMatch(/not allowed/);
    }
    // The login URL of a profile is checked the same way.
    const r = await start(c, { url: "https://example.com", authProfiles: [{ name: "x", loginUrl: "http://127.0.0.1:9/login", method: "manual" }] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/login URL .* is not allowed/);
  });

  it("rejects malformed job ids (no path traversal through the API)", async () => {
    for (const id of ["..", "../etc", "ZZZ", "0123456789abcdeg"]) {
      const r = await alice.get(`/api/crawl/${encodeURIComponent(id)}`);
      // ".." segments are normalised away by the server (308) before any handler runs.
      expect([308, 400, 404], id).toContain(r.status);
    }
    expect((await alice.get("/api/crawl/0123456789abcdef/report/..%2f..%2fetc%2fpasswd")).status).toBe(404);
  });

  it("runs a full crawl with live SSE progress, then serves ZIP (with checksum), reports and history", async () => {
    const r = await start(alice, { url: fx.url + "/", options: { maxPages: 25, delayMs: 0, retryBaseMs: 5, maxQueryVariantsPerPath: 3 } });
    expect(r.status).toBe(201);
    const { id, mode } = await r.json();
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(mode).toBe("public");

    const events = await done(open.base, alice, id);
    const types = new Set(events.map((e) => e.type));
    for (const t of ["snapshot", "log", "stats", "done"]) expect(types.has(t), t).toBe(true);
    // Lines emitted before the stream connected arrive in the snapshot; later ones as "log" events.
    const tags = new Set([...events.filter((e) => e.type === "snapshot").flatMap((e) => e.data.logs), ...events.filter((e) => e.type === "log").map((e) => e.data)].map((l) => l.tag));
    for (const t of ["FOUND", "CRAWLING", "ASSET", "COMPLETE"]) expect(tags.has(t), t).toBe(true);
    const crawled = events.filter((e) => e.type === "stats").map((e) => e.data.pagesCrawled);
    expect([...crawled].sort((a, b) => a - b)).toEqual(crawled);
    expect(events.at(-1)!.data.status).toBe("completed");

    // Reconnecting with Last-Event-ID replays only what was missed.
    const logIds = events.filter((e) => e.type === "log" && e.id).map((e) => e.id!);
    const mid = logIds[Math.floor(logIds.length / 2)];
    const replay = await readSse(`${open.base}/api/crawl/${id}/events`, alice.cookie, (e) => e.type === "done", 20000, { "last-event-id": String(mid) });
    expect(replay.at(-1)!.type).toBe("done");

    const job = (await alice.json(`/api/crawl/${id}`)).job;
    expect(job).toMatchObject({ status: "completed", hasZip: true, mode: "public" });
    expect(job.stats.pagesCrawled).toBeGreaterThanOrEqual(10);
    expect(job.ownerId).toBeUndefined();

    const zipRes = await alice.get(`/api/crawl/${id}/download`);
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("content-type")).toBe("application/zip");
    expect(zipRes.headers.get("cache-control")).toContain("no-store");
    expect(zipRes.headers.get("content-disposition")).toMatch(/attachment; filename="127\.0\.0\.1-[a-f0-9]{8}\.zip"/);
    const bytes = Buffer.from(await zipRes.arrayBuffer());
    const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    expect(zipRes.headers.get("x-archive-sha256")).toBe(sha);
    const zip = new AdmZip(bytes);
    expect(zip.test()).toBe(true);
    const names = zip.getEntries().map((e) => e.entryName);
    for (const n of ["index.html", "about/index.html", "_report/crawl-report.json"]) expect(names).toContain(n);
    const report = JSON.parse(zip.readAsText("_report/crawl-report.json"));
    expect(report.status).toBe("completed");
    expect(report.stats.status).toBe("completed");
    // The reported duration is the crawl's own active time: positive and no longer than the wall-clock span.
    const wall = new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime();
    expect(report.durationMs).toBeGreaterThan(0);
    expect(report.durationMs).toBeLessThanOrEqual(wall + 1000);

    // Download metadata is persisted with the job.
    const row = (await pg.query<any>("select storage, storage_key, zip_sha256, zip_entries, zip_bytes, download_count, last_downloaded_at from crawl_jobs where id = $1", [id]))[0];
    expect(row).toMatchObject({ storage: "local", storage_key: `jobs/${id}/site.zip`, zip_sha256: sha, zip_entries: names.length, download_count: 1 });
    expect(Number(row.zip_bytes)).toBe(bytes.length);
    expect(row.last_downloaded_at).not.toBeNull();
    // The archive lives in the archive store; the crawl's working directory is gone.
    expect(fs.existsSync(path.join(dataDir, "_store", "jobs", id, "site.zip"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, id))).toBe(false);

    const rep = await alice.get(`/api/crawl/${id}/report/crawl-report.html`);
    expect(rep.status).toBe(200);
    expect(rep.headers.get("content-security-policy")).toContain("sandbox");
    expect((await alice.get(`/api/crawl/${id}/report/failed-urls.txt`)).status).toBe(200);
    expect((await alice.get(`/api/crawl/${id}/report/secret.txt`)).status).toBe(404);

    const hist = await alice.json("/api/crawl");
    expect(hist.jobs.some((j: any) => j.id === id && j.status === "completed")).toBe(true);

    expect((await alice.del(`/api/crawl/${id}`)).status).toBe(200);
    expect((await alice.get(`/api/crawl/${id}`)).status).toBe(404);
    expect(fs.existsSync(path.join(dataDir, "_store", "jobs", id))).toBe(false);
    expect(await pg.query("select 1 from job_events where job_id = $1", [id])).toEqual([]);
  });

  it("pause / resume / cancel through the API", async () => {
    fx.slowMs = 200;
    try {
      const { id } = await (await start(alice, { url: fx.url + "/slow/1", options: { concurrency: 1, useSitemap: false, maxDepth: 30, delayMs: 0 } })).json();
      const ctl = (action: string) => alice.post(`/api/crawl/${id}/control`, { action });
      const job = async () => (await alice.json(`/api/crawl/${id}`)).job;
      await waitFor("first pages", async () => (await job()).stats?.pagesCrawled >= 2);
      expect((await ctl("pause")).status).toBe(200);
      const a = await waitFor("paused", async () => ((await job()).status === "paused" ? job() : null));
      await new Promise((r) => setTimeout(r, 1200));
      const b = await job();
      expect(b.status).toBe("paused");
      expect(b.stats.pagesCrawled).toBe(a.stats.pagesCrawled);
      expect((await ctl("resume")).status).toBe(200);
      const c = await waitFor("progress after resume", async () => {
        const j = await job();
        return j.status === "running" && j.stats.pagesCrawled > b.stats.pagesCrawled ? j : null;
      });
      expect(c.status).toBe("running");
      expect((await ctl("bogus")).status).toBe(400);
      expect((await ctl("cancel")).status).toBe(200);
      const events = await done(open.base, alice, id);
      expect(events.at(-1)!.data.status).toBe("cancelled");
      const d = await job();
      expect(d.status).toBe("cancelled");
      expect(d.hasZip).toBe(true);
      expect((await ctl("pause")).status).toBe(409); // no longer running
      await alice.del(`/api/crawl/${id}`);
    } finally {
      fx.slowMs = 0;
    }
  });

  it("limits the number of simultaneous crawls per user", async () => {
    fx.slowMs = 300;
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await start(alice, { url: `${fx.url}/slow/${i + 1}`, options: { concurrency: 1, useSitemap: false, maxDepth: 40, delayMs: 0 } });
        expect(r.status).toBe(201);
        ids.push((await r.json()).id);
      }
      const fourth = await start(alice, { url: `${fx.url}/slow/9`, options: { useSitemap: false } });
      expect(fourth.status).toBe(429);
      // Another user is not affected by alice's quota.
      const other = await start(bob, { url: `${fx.url}/about`, options: { useSitemap: false, maxDepth: 0 } });
      expect(other.status).toBe(201);
      const otherId = (await other.json()).id;
      for (const id of ids) await alice.post(`/api/crawl/${id}/control`, { action: "cancel" });
      for (const id of ids) await done(open.base, alice, id);
      await done(open.base, bob, otherId);
      for (const id of ids) expect((await alice.del(`/api/crawl/${id}`)).status).toBe(200);
      expect((await bob.del(`/api/crawl/${otherId}`)).status).toBe(200);
    } finally {
      fx.slowMs = 0;
    }
  });
});

describe("job ownership", () => {
  it("a user can neither see nor touch another user's job, reports, events, ZIP or login sessions", async () => {
    const r = await start(alice, { url: fx.url + "/about", options: { useSitemap: false, maxDepth: 0, delayMs: 0 } });
    const { id } = await r.json();
    await done(open.base, alice, id);
    expect((await alice.get(`/api/crawl/${id}`)).status).toBe(200);

    for (const p of [`/api/crawl/${id}`, `/api/crawl/${id}/events`, `/api/crawl/${id}/download`, `/api/crawl/${id}/report/crawl-report.json`, `/api/crawl/${id}/auth`, `/api/crawl/${id}/login`, `/api/crawl/${id}/login/abcdef0123456789`, `/api/crawl/${id}/login/abcdef0123456789/frame`]) {
      const res = await bob.get(p);
      expect(res.status, `bob GET ${p}`).toBe(404);
    }
    expect((await bob.post(`/api/crawl/${id}/control`, { action: "cancel" })).status).toBe(404);
    expect((await bob.post(`/api/crawl/${id}/auth`)).status).toBe(404);
    expect((await bob.post(`/api/crawl/${id}/login/abcdef0123456789`, { action: "confirm" })).status).toBe(404);
    expect((await bob.del(`/api/crawl/${id}`)).status).toBe(404);
    // A foreign job is indistinguishable from one that does not exist.
    const foreign = await (await bob.get(`/api/crawl/${id}`)).json();
    const missing = await (await bob.get("/api/crawl/0123456789abcdef")).json();
    expect(foreign).toEqual(missing);
    expect((await bob.json("/api/crawl")).jobs.some((j: any) => j.id === id)).toBe(false);
    // Still there, untouched, for its owner.
    const mine = (await alice.json(`/api/crawl/${id}`)).job;
    expect(mine.status).toBe("completed");
    expect((await alice.get(`/api/crawl/${id}/download`)).status).toBe(200);
    expect((await alice.del(`/api/crawl/${id}`)).status).toBe(200);
  });

  it("jobs created before ownership existed (owner_id NULL) are visible to nobody", async () => {
    await pg.query("insert into crawl_jobs (id, url, status, options) values ('aaaaaaaaaaaaaaaa', 'https://legacy.example/', 'completed', '{}'::jsonb)");
    for (const c of [alice, bob]) {
      expect((await c.get("/api/crawl/aaaaaaaaaaaaaaaa")).status).toBe(404);
      expect((await c.json("/api/crawl")).jobs.some((j: any) => j.id === "aaaaaaaaaaaaaaaa")).toBe(false);
    }
    await pg.query("delete from crawl_jobs where id = 'aaaaaaaaaaaaaaaa'");
  });
});

describe("authenticated crawls through the API", () => {
  const profile = (username: string, extra: Record<string, unknown> = {}) => ({
    name: username.split("@")[0],
    loginUrl: `${auth.url}/login`,
    username,
    password: `pw-${username}`,
    loginButtonSelector: "#login",
    usernameSelector: 'input[name="username"]',
    passwordSelector: 'input[name="password"]',
    authenticatedSelector: ".account[data-authenticated=true]",
    method: "form",
    ...extra,
  });
  const opts = { renderMode: "js", useSitemap: false, respectRobots: false, maxDepth: 3, maxPages: 15, delayMs: 0 };
  const dbDump = async () => JSON.stringify([await pg.query("select * from crawl_jobs"), await pg.query("select * from auth_profiles"), await pg.query("select * from job_events"), await pg.query("select * from job_commands"), await pg.query("select id, job_id, status, message, page_url, page_title from login_sessions")]);

  it("stores credentials only encrypted, never returns them, crawls with the session and wipes them when the job ends", async () => {
    const r = await start(alice, { url: `${auth.url}/dashboard`, options: { ...opts, apiDiscovery: "archive" }, authProfiles: [{ ...profile("erin@example.test"), id: "client-chosen-id" }] });
    expect(r.status).toBe(201);
    const created = await r.json();
    expect(created.mode).toBe("authenticated");
    expect(JSON.stringify(created)).not.toContain("pw-erin");
    const id = created.id as string;

    // While the job is alive the secret exists only as an AES-GCM envelope.
    const stored = (await pg.query<{ id: string; secret: string | null; username_hint: string }>("select id, secret, username_hint from auth_profiles where job_id = $1", [id]))[0];
    expect(stored.id).toMatch(/^[a-f0-9]{16}$/); // the client-supplied id was discarded
    expect(stored.username_hint).toBe("er***@example.test");
    if (stored.secret) {
      expect(stored.secret).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(stored.secret).not.toContain("pw-erin");
      expect(stored.secret).not.toContain("erin@example.test");
    }

    const events = await done(open.base, alice, id);
    expect(events.at(-1)!.data.status).toBe("completed");
    expect(JSON.stringify(events)).not.toContain("pw-erin");

    const a = await alice.json(`/api/crawl/${id}/auth`);
    expect(a.profiles).toHaveLength(1);
    expect(a.profiles[0]).toMatchObject({ name: "erin", method: "form", status: "completed", credentialsStored: false, sessionStored: false, usernameHint: "er***@example.test" });
    expect(JSON.stringify(a)).not.toContain("pw-erin");
    const after = (await pg.query<any>("select secret, session_state, cleared_at from auth_profiles where job_id = $1", [id]))[0];
    expect(after.secret).toBeNull();
    expect(after.session_state).toBeNull();
    expect(after.cleared_at).not.toBeNull();
    expect(await dbDump()).not.toContain("pw-erin");

    const zip = new AdmZip(Buffer.from(await (await alice.get(`/api/crawl/${id}/download`)).arrayBuffer()));
    expect(zip.readAsText("account/orders/index.html")).toContain("Private orders for erin@example.test");
    expect(zip.readAsText("private/avatar.svg")).toContain("avatar-of-erin@example.test");
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("_report/api-discovery.json");
    expect(names.some((n) => n.startsWith("_api/api/orders"))).toBe(true);
    const everything = zip.getEntries().map((e) => e.getData().toString("latin1")).join("\n");
    expect(everything).not.toContain("pw-erin");
    expect((await alice.get(`/api/crawl/${id}/report/api-discovery.json`)).status).toBe(200);
    // Bob cannot read the private archive.
    expect((await bob.get(`/api/crawl/${id}/download`)).status).toBe(404);
    expect((await alice.del(`/api/crawl/${id}`)).status).toBe(200);
    expect(await pg.query("select 1 from auth_profiles where job_id = $1", [id])).toEqual([]);
  });

  it("a wrong password fails the job with a safe message and wipes the credentials", async () => {
    const r = await start(alice, { url: `${auth.url}/dashboard`, options: { ...opts, requestTimeoutMs: 5000 }, authProfiles: [profile("frank@example.test", { password: "definitely-wrong-password" })] });
    const { id } = await r.json();
    const events = await done(open.base, alice, id);
    expect(events.at(-1)!.data.status).toBe("failed");
    const job = (await alice.json(`/api/crawl/${id}`)).job;
    expect(job.status).toBe("failed");
    expect(JSON.stringify(job)).not.toContain("definitely-wrong-password");
    expect(JSON.stringify(events)).not.toContain("definitely-wrong-password");
    expect((await pg.query<any>("select secret from auth_profiles where job_id = $1", [id]))[0].secret).toBeNull();
    await alice.del(`/api/crawl/${id}`);
  });

  it("manual sign-in over the API: screenshot stream, forwarded input, MFA code, then the crawl continues", async () => {
    const r = await start(alice, { url: `${auth.url}/dashboard`, options: opts, authProfiles: [{ name: "Manual MFA", loginUrl: `${auth.url}/login`, method: "manual", authenticatedSelector: ".account[data-authenticated=true]" }] });
    expect(r.status).toBe(201);
    const { id } = await r.json();

    const session = await waitFor("sign-in session", async () => {
      const l = await alice.json(`/api/crawl/${id}/login`);
      // The page address is published with the session or, at the latest, with the first frame.
      return l.sessions?.find((s: any) => s.status === "awaiting-user" && s.pageUrl) ?? null;
    });
    expect(session.reason).toBe("manual-login");
    expect(session.pageUrl).toBe(`${auth.url}/login`);
    const sid = session.id as string;
    // The job row follows within one worker tick: waiting for a person counts as paused.
    await waitFor("job paused while waiting for the sign-in", async () => (await alice.json(`/api/crawl/${id}`)).job.status === "paused", 15000);

    // The owner sees the isolated browser as JPEG frames; nobody else does.
    const frame = await waitFor("first frame", async () => {
      const f = await alice.get(`/api/crawl/${id}/login/${sid}/frame`);
      return f.status === 200 ? f : null;
    });
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    expect(frame.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await frame.arrayBuffer()).subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect((await bob.get(`/api/crawl/${id}/login/${sid}/frame`)).status).toBe(404);
    expect((await bob.post(`/api/crawl/${id}/login/${sid}`, { action: "input", event: { type: "type", text: "x" } })).status).toBe(404);
    // Frames are stored encrypted.
    const raw = (await pg.query<{ frame: string | null }>("select frame from login_sessions where id = $1", [sid]))[0].frame;
    expect(raw).toMatch(/^v2\./);

    const input = async (event: Record<string, unknown>) => {
      const res = await alice.post(`/api/crawl/${id}/login/${sid}`, { action: "input", event });
      expect(res.status, JSON.stringify(event)).toBe(200);
    };
    expect((await alice.post(`/api/crawl/${id}/login/${sid}`, { action: "input", event: { type: "evaluate", script: "alert(1)" } })).status).toBe(400);
    expect((await alice.post(`/api/crawl/${id}/login/${sid}`, { action: "navigate" })).status).toBe(400);

    await input({ type: "click", x: 5, y: 300 });
    await input({ type: "key", key: "Tab" });
    await input({ type: "type", text: "mfa-gina@example.test" });
    await input({ type: "key", key: "Tab" });
    await input({ type: "type", text: "pw-mfa-gina@example.test" });
    await input({ type: "key", key: "Enter" });
    // The site now asks for a one-time code. The crawler does not answer it.
    await waitFor("MFA page", async () => (await alice.json(`/api/crawl/${id}/login/${sid}`)).session.pageUrl === `${auth.url}/mfa`);
    expect(auth.stats.mfaPosts).toBe(0);
    // Typed text never sits in the database in clear text.
    expect(await dbDump()).not.toContain("pw-mfa-gina");
    await input({ type: "type", text: "123456" });
    await input({ type: "key", key: "Enter" });

    const events = await done(open.base, alice, id, 120000);
    expect(events.at(-1)!.data.status).toBe("completed");
    const finished = (await alice.json(`/api/crawl/${id}/login/${sid}`)).session;
    expect(finished.status).toBe("authenticated");
    // Once the sign-in is over there is no picture any more (204, empty), and none is kept in the database.
    const after = await alice.get(`/api/crawl/${id}/login/${sid}/frame`);
    expect(after.status).toBe(204);
    expect((await after.arrayBuffer()).byteLength).toBe(0);
    expect((await pg.query<any>("select frame from login_sessions where id = $1", [sid]))[0].frame).toBeNull();
    expect(await pg.query("select 1 from job_commands where job_id = $1 and payload is not null", [id])).toEqual([]);
    const zip = new AdmZip(Buffer.from(await (await alice.get(`/api/crawl/${id}/download`)).arrayBuffer()));
    expect(zip.readAsText("dashboard/index.html")).toContain("Account mfa-gina@example.test");
    await alice.del(`/api/crawl/${id}`);
  });

  it("clearing credentials during a sign-in ends the crawl and removes every secret", async () => {
    const r = await start(alice, { url: `${auth.url}/dashboard`, options: opts, authProfiles: [{ name: "Manual", loginUrl: `${auth.url}/login`, method: "manual", authenticatedSelector: ".account[data-authenticated=true]" }] });
    const { id } = await r.json();
    await waitFor("sign-in session", async () => (await alice.json(`/api/crawl/${id}/login`)).sessions?.some((s: any) => s.status === "awaiting-user"));
    const cleared = await alice.post(`/api/crawl/${id}/auth`);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ credentialsRemoved: true, activeSessionCancelled: true });
    const events = await done(open.base, alice, id);
    expect(["failed", "cancelled"]).toContain(events.at(-1)!.data.status);
    const rows = await pg.query<any>("select secret, session_state from auth_profiles where job_id = $1", [id]);
    expect(rows.every((p) => p.secret === null && p.session_state === null)).toBe(true);
    expect((await pg.query<any>("select frame from login_sessions where job_id = $1", [id])).every((s) => s.frame === null)).toBe(true);
    await alice.del(`/api/crawl/${id}`);
  });

  it("combined discovery through the API produces one archive with per-profile folders and the access matrix", async () => {
    const r = await start(alice, { url: `${auth.url}/dashboard`, options: opts, authMode: "combined", authProfiles: [profile("hank@example.test"), profile("admin-ivy@example.test")] });
    expect(r.status).toBe(201);
    const created = await r.json();
    expect(created.mode).toBe("combined");
    expect(created.ids).toHaveLength(1);
    const id = created.id as string;
    const events = await done(open.base, alice, id, 150000);
    expect(events.at(-1)!.data.status).toBe("completed");
    const a = await alice.json(`/api/crawl/${id}/auth`);
    expect(a.profiles.map((p: any) => p.name)).toEqual(["hank", "admin-ivy"]);
    expect(a.profiles.every((p: any) => p.credentialsStored === false)).toBe(true);

    const matrixRes = await alice.get(`/api/crawl/${id}/report/access-matrix.json`);
    expect(matrixRes.status).toBe(200);
    const matrix = await matrixRes.json();
    const admin = matrix.find((m: any) => m.url.endsWith("/admin/reports"));
    expect(admin).toMatchObject({ discoveredBy: ["admin-ivy"], accessibleBy: ["admin-ivy"], deniedFor: ["hank"] });
    expect((await alice.get(`/api/crawl/${id}/report/access-matrix.csv`)).status).toBe(200);
    expect((await alice.get(`/api/crawl/${id}/report/combined-report.json`)).status).toBe(200);

    const zip = new AdmZip(Buffer.from(await (await alice.get(`/api/crawl/${id}/download`)).arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("profiles/hank/dashboard/index.html");
    expect(names).toContain("profiles/admin-ivy/admin/reports/index.html");
    expect(names.some((n) => n.startsWith("profiles/hank/admin/"))).toBe(false);
    expect(names).toContain("_report/access-matrix.json");
    await alice.del(`/api/crawl/${id}`);

    // Fewer than two profiles is not a combined crawl.
    const one = await start(alice, { url: `${auth.url}/dashboard`, authMode: "combined", authProfiles: [profile("hank@example.test")] });
    expect(one.status).toBe(400);
  });

  it("the login self-test never returns or logs the credentials", async () => {
    const ok = await alice.post("/api/auth/test", { profile: profile("jo@example.test") });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain("pw-jo");
    const bad = await alice.post("/api/auth/test", { profile: profile("jo@example.test", { password: "wrong-password-1" }) });
    expect(bad.status).toBe(400);
    const badBody = await bad.json();
    expect(badBody.error).toMatch(/Login failed/);
    expect(JSON.stringify(badBody)).not.toContain("wrong-password-1");
    expect(open.output()).not.toContain("pw-jo");
    expect(open.output()).not.toContain("wrong-password-1");
  });
});
