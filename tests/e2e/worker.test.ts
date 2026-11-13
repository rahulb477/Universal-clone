import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAuthSite } from "../fixtures/auth-site";
import { startFixture, type Fixture } from "../fixtures/site";
import { requireChromium } from "../helpers";
import { startPostgres, type TestPostgres } from "../setup/postgres";
import { startS3, type TestS3 } from "../setup/s3";
import { bootWeb, bootWorker, envWithoutBrowser, freePort, readSse, runCli, signIn, waitFor, type Client, type Proc, type Web } from "../setup/server";

/**
 * The deployment split: a web tier with no browser and no shared disk ("Vercel"), a separate
 * persistent worker process (`npm run worker`), PostgreSQL as the queue between them and an
 * S3-compatible archive store. All four are real processes.
 */

let pg: TestPostgres;
let s3: TestS3;
let fx: Fixture;
let auth: Awaited<ReturnType<typeof startAuthSite>>;
let web: Web;
let user: Client;
let other: Client;
const workers: Proc[] = [];
const webData = fs.mkdtempSync(path.join(os.tmpdir(), "uc-web-"));
const workerData = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worker-"));
const PASSWORD = "correct horse battery staple";

const workerEnv = (extra: Record<string, string> = {}) => ({ DATABASE_URL: pg.url, CRAWL_DATA_DIR: workerData, CRAWLER_ALLOW_PRIVATE_NETWORKS: "1", WORKER_STALE_SECONDS: "15", ...s3.env, ...extra });
async function startWorker(extra: Record<string, string> = {}) {
  const w = await bootWorker(workerEnv(extra));
  workers.push(w);
  return w;
}
const job = async (id: string, c: Client = user) => (await c.json(`/api/crawl/${id}`)).job;
const row = async (id: string) => (await pg.query<any>("select * from crawl_jobs where id = $1", [id]))[0];
const untilStatus = (id: string, statuses: string[], timeoutMs = 90000) => waitFor(`job ${id} to be ${statuses.join("/")}`, async () => (statuses.includes((await job(id)).status) ? job(id) : null), timeoutMs);
const slow = { concurrency: 1, useSitemap: false, maxDepth: 20, delayMs: 0 };

beforeAll(async () => {
  requireChromium();
  pg = await startPostgres();
  s3 = await startS3();
  await pg.migrate();
  for (const email of ["owner@split.test", "other@split.test"]) expect(runCli("scripts/create-user.ts", [email], { DATABASE_URL: pg.url, USER_PASSWORD: PASSWORD }).code).toBe(0);
  fx = await startFixture();
  auth = await startAuthSite({ rich: true });
  // The web tier gets neither a Chromium path nor the worker's data directory.
  web = await bootWeb({ DATABASE_URL: pg.url, CRAWL_DATA_DIR: webData, CRAWLER_WORKER_MODE: "external", CRAWLER_ALLOW_PRIVATE_NETWORKS: "1", CRAWLER_STARTS_PER_MINUTE: "100", CRAWLER_MAX_ACTIVE_JOBS_PER_USER: "10", ...s3.env }, envWithoutBrowser());
  user = await signIn(web.base, "owner@split.test", PASSWORD);
  other = await signIn(web.base, "other@split.test", PASSWORD);
}, 180000);

afterAll(async () => {
  for (const w of workers) await w.stop("SIGKILL");
  await web?.stop();
  await fx?.close();
  await auth?.close();
  await s3?.close();
  await pg?.stop();
  fs.rmSync(webData, { recursive: true, force: true });
  fs.rmSync(workerData, { recursive: true, force: true });
});

describe("web tier without a worker", () => {
  it("reports the worker as offline, queues jobs and never runs a crawl itself", async () => {
    expect(await (await fetch(web.base + "/api/health")).json()).toEqual({ ok: true, worker: "offline" });
    const me = await user.json("/api/auth/me");
    expect(me.features).toMatchObject({ workerMode: "external", workerOnline: false });
    // The login self-test needs a browser, which the web tier does not have.
    expect((await user.post("/api/auth/test", { profile: {} })).status).toBe(501);

    const r = await user.post("/api/crawl", { url: fx.url + "/about", confirmPermission: true, options: { useSitemap: false, maxDepth: 0 } });
    expect(r.status).toBe(201);
    const created = await r.json();
    expect(created.workerOnline).toBe(false);
    await new Promise((res) => setTimeout(res, 3000));
    expect((await job(created.id)).status).toBe("queued");
    expect(fx.hits.get("/about") ?? 0).toBe(0);
    // A queued job can be cancelled without any worker.
    expect((await user.post(`/api/crawl/${created.id}/control`, { action: "cancel" })).status).toBe(200);
    expect((await job(created.id)).status).toBe("cancelled");
    expect((await user.del(`/api/crawl/${created.id}`)).status).toBe(200);
    // Nothing crawl-related was written on the web tier's disk.
    expect(fs.readdirSync(webData).filter((f) => /^[a-f0-9]{16}$/.test(f))).toEqual([]);
  });
});

describe("worker process", () => {
  it("refuses to start without a database, and fails loudly on wrong storage credentials", async () => {
    await expect(bootWorker({ DATABASE_URL: "" })).rejects.toThrow(/DATABASE_URL is required/);
    await expect(bootWorker(workerEnv({ S3_SECRET_ACCESS_KEY: "wrong-secret" }))).rejects.toThrow(/object storage upload failed: HTTP 403/);
  });

  it("logs the browser process failure, not just Playwright's generic first line", async () => {
    // Node is a dynamically linked executable with a working --version, but it
    // rejects Chromium's launch flags and prints the real error on stderr.
    await expect(bootWorker(workerEnv({ CHROMIUM_PATH: process.execPath }))).rejects.toThrow(/bad option/);
  });

  it("recovers from stale and deleted registrations and reports health using database time", async () => {
    const w = await startWorker({ WORKER_ID: "heartbeat-regression" });
    try {
      const initial = (await pg.query<{ heartbeat_at: Date }>("select heartbeat_at from workers where id = $1", ["heartbeat-regression"]))[0];
      expect(initial).toBeDefined();
      await waitFor("heartbeat advances", async () => {
        const row = (await pg.query<{ heartbeat_at: Date }>("select heartbeat_at from workers where id = $1", ["heartbeat-regression"]))[0];
        return row && row.heartbeat_at > initial.heartbeat_at;
      }, 15000);
      expect(await (await fetch(web.base + "/api/health")).json()).toEqual({ ok: true, worker: "online" });
      // Freeze the process, age its row using PostgreSQL's clock and verify the actual web route.
      w.proc.kill("SIGSTOP");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await pg.query("update workers set heartbeat_at = now() - interval '31 seconds' where id = $1", ["heartbeat-regression"]);
      expect(await (await fetch(web.base + "/api/health")).json()).toEqual({ ok: true, worker: "offline" });
      // Simulate stale-row cleanup by another worker after a prolonged outage.
      await pg.query("delete from workers where id = $1", ["heartbeat-regression"]);
      w.proc.kill("SIGCONT");
      await waitFor("re-registration and online health", async () => {
        const health = await (await fetch(web.base + "/api/health")).json();
        return health.worker === "online" && (await pg.query("select id from workers where id = $1", ["heartbeat-regression"])).length > 0;
      }, 15000);
      fx.slowMs = 250;
      const response = await user.post("/api/crawl", { url: fx.url + "/slow/1", confirmPermission: true, options: { ...slow, maxPages: 8 } });
      expect(response.status).toBe(201);
      const { id } = await response.json();
      await waitFor("reconnected worker claims crawl", async () => {
        const r = await row(id);
        return r.status === "running" && r.worker_id === "heartbeat-regression";
      });
      await untilStatus(id, ["completed"]);
      const finished = await row(id);
      expect(finished.stats.pagesCrawled).toBeGreaterThan(0);
      expect(finished.finished_at).toBeTruthy();
      expect((await pg.query("select id from job_events where job_id = $1 and type = 'done'", [id])).length).toBe(1);
      expect((await user.del(`/api/crawl/${id}`)).status).toBe(200);
    } finally {
      fx.slowMs = 0;
      w.proc.kill("SIGCONT");
      await w.stop("SIGTERM");
    }
    expect(await (await fetch(web.base + "/api/health")).json()).toEqual({ ok: true, worker: "offline" });
  });

  it("refuses a configured database identity mismatch without exposing the URL", async () => {
    await expect(bootWorker(workerEnv({ DATABASE_EXPECTED_FINGERPRINT: "incorrect" }))).rejects.toThrow(/fingerprint differs from the web app/);
  });

  it("picks up a queued job, uploads the archive to object storage, and the web tier hands out a short-lived download link to the owner only", async () => {
    const r = await user.post("/api/crawl", { url: fx.url + "/", confirmPermission: true, options: { maxPages: 12, delayMs: 0, retryBaseMs: 5 } });
    const { id } = await r.json();
    expect((await job(id)).status).toBe("queued");

    const healthPort = await freePort();
    const w = await startWorker({ WORKER_ID: "worker-a", WORKER_HEALTH_PORT: String(healthPort), WORKER_HEALTH_HOST: "127.0.0.1" });
    expect(w.output()).toMatch(/\[worker\] Chromium [\d.]+ via /);
    const health = await waitFor("worker health listener", async () => {
      try { return await fetch(`http://127.0.0.1:${healthPort}/healthz`); } catch { return null; }
    });
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);
    expect((await fetch(`http://127.0.0.1:${healthPort}/`)).status).toBe(404);
    const events = await readSse(`${web.base}/api/crawl/${id}/events`, user.cookie, (e) => e.type === "done");
    expect(events.at(-1)!.data.status).toBe("completed");
    expect(await (await fetch(web.base + "/api/health")).json()).toEqual({ ok: true, worker: "online" });
    expect((await user.json("/api/auth/me")).features.workerOnline).toBe(true);

    const done = await row(id);
    expect(done).toMatchObject({ status: "completed", storage: "s3", storage_key: `jobs/${id}/site.zip`, has_zip: true, worker_id: null });
    expect(s3.objects()).toContain(`jobs/${id}/site.zip`);
    expect(s3.objects()).toContain(`jobs/${id}/report/crawl-report.json`);
    // The worker's scratch directory is cleaned up; the web tier never had one.
    expect(fs.existsSync(path.join(workerData, id))).toBe(false);

    const dl = await user.get(`/api/crawl/${id}/download`);
    expect(dl.status).toBe(302);
    expect(dl.headers.get("cache-control")).toContain("no-store");
    const link = dl.headers.get("location")!;
    expect(link.startsWith(`${s3.endpoint}/${s3.bucket}/jobs/${id}/site.zip?`)).toBe(true);
    expect(link).toContain("X-Amz-Expires=60");
    const bytes = Buffer.from(await (await fetch(link)).arrayBuffer());
    expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(done.zip_sha256);
    const zip = new AdmZip(bytes);
    expect(zip.test()).toBe(true);
    expect(zip.getEntries().length).toBe(done.zip_entries);
    expect(zip.getEntries().map((e) => e.entryName)).toContain("about/index.html");
    expect((await row(id)).download_count).toBe(1);

    // Reports are proxied from the store after the ownership check.
    const rep = await user.get(`/api/crawl/${id}/report/crawl-report.json`);
    expect(rep.status).toBe(200);
    expect((await rep.json()).status).toBe("completed");
    // Another user gets no link and no report; the bucket itself is not public.
    expect((await other.get(`/api/crawl/${id}/download`)).status).toBe(404);
    expect((await other.get(`/api/crawl/${id}/report/crawl-report.json`)).status).toBe(404);
    expect((await fetch(`${s3.endpoint}/${s3.bucket}/jobs/${id}/site.zip`)).status).toBe(403);

    // Deleting the job removes the objects.
    expect((await user.del(`/api/crawl/${id}`)).status).toBe(200);
    expect(s3.objects().filter((k) => k.includes(id))).toEqual([]);
  });

  it("graceful shutdown (SIGTERM) saves running crawls as interrupted; resume continues without re-downloading finished pages", async () => {
    fx.slowMs = 250;
    try {
      const { id } = await (await user.post("/api/crawl", { url: fx.url + "/slow/1", confirmPermission: true, options: { ...slow, maxPages: 14 } })).json();
      await waitFor("some progress", async () => ((await job(id)).stats?.pagesCrawled ?? 0) >= 4);
      const w = workers.at(-1)!;
      const code = await w.stop("SIGTERM");
      expect(code).toBe(0);
      expect(w.output()).toContain("SIGTERM received, saving running crawls");

      const stopped = await job(id);
      expect(stopped.status).toBe("interrupted");
      expect(stopped.stopReason).toMatch(/worker stopped/i);
      const crawledBefore = stopped.stats.pagesCrawled as number;
      expect(crawledBefore).toBeGreaterThanOrEqual(4);
      expect(crawledBefore).toBeLessThan(14);
      expect((await row(id)).worker_id).toBeNull();
      expect(await (await fetch(web.base + "/api/health")).json()).toEqual({ ok: true, worker: "offline" });
      // The owner is told through the live stream as well.
      const seen = await readSse(`${web.base}/api/crawl/${id}/events`, user.cookie, (e) => e.type === "snapshot", 10000);
      expect(seen[0].data.job.status).toBe("interrupted");

      // A new worker does not restart the job on its own: resuming is the owner's decision.
      await startWorker({ WORKER_ID: "worker-b" });
      await new Promise((r) => setTimeout(r, 2500));
      expect((await job(id)).status).toBe("interrupted");
      expect((await other.post(`/api/crawl/${id}/control`, { action: "resume" })).status).toBe(404);
      const resumed = await user.post(`/api/crawl/${id}/control`, { action: "resume" });
      expect(resumed.status).toBe(200);
      expect((await resumed.json()).status).toBe("queued");

      const finished = await untilStatus(id, ["completed", "failed", "cancelled"]);
      expect(finished.status).toBe("completed");
      expect(finished.stats.pagesCrawled).toBe(14);
      // Pages finished before the shutdown were not requested again.
      for (let n = 1; n <= crawledBefore - 1; n++) expect(fx.hits.get(`/slow/${n}`), `/slow/${n}`).toBe(1);
      for (let n = 1; n <= 14; n++) expect(fx.hits.get(`/slow/${n}`) ?? 0, `/slow/${n}`).toBeGreaterThanOrEqual(1);
      const link = (await user.get(`/api/crawl/${id}/download`)).headers.get("location")!;
      const zip = new AdmZip(Buffer.from(await (await fetch(link)).arrayBuffer()));
      const names = zip.getEntries().map((e) => e.entryName);
      for (let n = 1; n <= 14; n++) expect(names, `slow/${n}`).toContain(`slow/${n}/index.html`);
      await user.del(`/api/crawl/${id}`);
    } finally {
      fx.slowMs = 0;
    }
  });

  it("a crashed worker (SIGKILL) is detected by its missing heartbeat; the job becomes interrupted and can be resumed", async () => {
    fx.slowMs = 500;
    try {
      // A chain of pages, one link deep each: /slow/20 … /slow/40 (maxDepth 20) = 21 pages, about 10 s of crawling.
      const { id } = await (await user.post("/api/crawl", { url: fx.url + "/slow/20", confirmPermission: true, options: { ...slow, maxDepth: 20 } })).json();
      // State is saved every few seconds while crawling; wait until a save has certainly happened.
      await waitFor("progress", async () => ((await job(id)).stats?.pagesCrawled ?? 0) >= 6);
      await new Promise((r) => setTimeout(r, 3500));
      const victim = workers.at(-1)!;
      await victim.stop("SIGKILL");
      // Nothing could be cleaned up: the row still claims to be running on the dead worker.
      const orphan = await row(id);
      expect(orphan.status).toBe("running");
      expect(orphan.worker_id).toBe("worker-b");

      await startWorker({ WORKER_ID: "worker-c" });
      const detected = await untilStatus(id, ["interrupted"], 60000);
      expect(detected.stopReason).toMatch(/worker stopped/i);
      const before = detected.stats.pagesCrawled as number;

      expect((await user.post(`/api/crawl/${id}/control`, { action: "resume" })).status).toBe(200);
      const finished = await untilStatus(id, ["completed", "failed", "cancelled"]);
      expect(finished.status).toBe("completed");
      expect(finished.stats.pagesCrawled).toBe(21);
      expect(finished.stats.pagesCrawled).toBeGreaterThan(before);
      // The first pages were saved before the crash and are not fetched twice.
      for (const n of [20, 21, 22]) expect(fx.hits.get(`/slow/${n}`), `/slow/${n}`).toBe(1);
      const link = (await user.get(`/api/crawl/${id}/download`)).headers.get("location")!;
      const names = new AdmZip(Buffer.from(await (await fetch(link)).arrayBuffer())).getEntries().map((e) => e.entryName);
      for (let n = 20; n <= 40; n++) expect(names, `slow/${n}`).toContain(`slow/${n}/index.html`);
      await user.del(`/api/crawl/${id}`);
    } finally {
      fx.slowMs = 0;
    }
  });

  it("an authenticated crawl survives a worker restart: credentials stay encrypted in the queue, the saved session is reused, and everything is wiped at the end", async () => {
    const before = auth.stats.loginPosts;
    const profile = { name: "Kim", loginUrl: `${auth.url}/login`, username: "kim@example.test", password: "pw-kim@example.test", loginButtonSelector: "#login", usernameSelector: 'input[name="username"]', passwordSelector: 'input[name="password"]', authenticatedSelector: ".account[data-authenticated=true]", method: "form" };
    const { id } = await (await user.post("/api/crawl", { url: `${auth.url}/dashboard`, confirmPermission: true, options: { renderMode: "js", useSitemap: false, respectRobots: false, maxDepth: 3, maxPages: 15, delayMs: 0, concurrency: 1, apiDiscovery: "off" }, authProfiles: [profile] })).json();
    await waitFor("first authenticated page", async () => ((await job(id)).stats?.pagesCrawled ?? 0) >= 1);
    expect(auth.stats.loginPosts).toBe(before + 1);
    await workers.at(-1)!.stop("SIGTERM");

    expect((await job(id)).status).toBe("interrupted");
    // While the job can still be resumed its secrets exist — encrypted, bound to the profile row.
    const kept = (await pg.query<any>("select secret, session_state from auth_profiles where job_id = $1", [id]))[0];
    expect(kept.secret).toMatch(/^v2\./);
    expect(kept.session_state).toMatch(/^v2\./);
    expect(kept.secret + kept.session_state).not.toContain("pw-kim");
    expect((await user.json(`/api/crawl/${id}/auth`)).profiles[0]).toMatchObject({ credentialsStored: true, sessionStored: true });

    await startWorker({ WORKER_ID: "worker-d", CRAWLER_MAX_CONCURRENT_JOBS: "2" });
    expect((await user.post(`/api/crawl/${id}/control`, { action: "resume" })).status).toBe(200);
    const events = await readSse(`${web.base}/api/crawl/${id}/events`, user.cookie, (e) => e.type === "done", 120000);
    expect(events.at(-1)!.data.status).toBe("completed");
    // The new worker restored the encrypted session instead of logging in again.
    expect(auth.stats.loginPosts).toBe(before + 1);
    const logs = (await pg.query<{ data: { message: string } }>("select data from job_events where job_id = $1 and type = 'log'", [id])).map((l) => l.data.message);
    expect(logs.some((m) => /Restored the saved browser session/.test(m))).toBe(true);

    const wiped = (await pg.query<any>("select secret, session_state, cleared_at from auth_profiles where job_id = $1", [id]))[0];
    expect(wiped).toMatchObject({ secret: null, session_state: null });
    expect(wiped.cleared_at).not.toBeNull();
    const link = (await user.get(`/api/crawl/${id}/download`)).headers.get("location")!;
    const zip = new AdmZip(Buffer.from(await (await fetch(link)).arrayBuffer()));
    expect(zip.readAsText("account/orders/index.html")).toContain("Private orders for kim@example.test");
    // Neither worker printed the password.
    for (const w of workers) expect(w.output()).not.toContain("pw-kim");
    expect(web.output()).not.toContain("pw-kim");
    await user.del(`/api/crawl/${id}`);
  });

  it("two workers share one queue and never run the same job twice", async () => {
    await startWorker({ WORKER_ID: "worker-e", CRAWLER_MAX_CONCURRENT_JOBS: "2" });
    fx.slowMs = 1500;
    try {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await user.post("/api/crawl", { url: `${fx.url}/slow/${60 + i}`, confirmPermission: true, options: { ...slow, maxDepth: 0 } });
        expect(r.status).toBe(201);
        ids.push((await r.json()).id);
      }
      // Watch who holds which job while they run.
      const claimedBy = new Map<string, Set<string>>();
      await waitFor(
        "all six jobs",
        async () => {
          const rows = await pg.query<{ id: string; status: string; worker_id: string | null }>("select id, status, worker_id from crawl_jobs where id = any($1)", [ids]);
          for (const r of rows) if (r.worker_id) claimedBy.set(r.id, (claimedBy.get(r.id) ?? new Set()).add(r.worker_id));
          return rows.every((r) => ["completed", "failed", "cancelled"].includes(r.status));
        },
        90000,
        100,
      );
      for (const id of ids) expect((await job(id)).status).toBe("completed");
      // Every job was held by exactly one worker, and both workers did some of the work.
      for (const id of ids) expect(claimedBy.get(id)?.size, id).toBe(1);
      expect(new Set([...claimedBy.values()].flatMap((v) => [...v]))).toEqual(new Set(["worker-d", "worker-e"]));
      // Each start page was fetched exactly once and each job was packaged exactly once.
      for (let i = 0; i < 6; i++) expect(fx.hits.get(`/slow/${60 + i}`), `/slow/${60 + i}`).toBe(1);
      const packaged = await pg.query<{ job_id: string; n: string }>("select job_id, count(*) as n from job_events where type = 'log' and data->>'message' like 'Creating ZIP archive%' and job_id = any($1) group by job_id", [ids]);
      expect(packaged).toHaveLength(6);
      expect(packaged.every((s) => Number(s.n) === 1)).toBe(true);
      for (const id of ids) await user.del(`/api/crawl/${id}`);
    } finally {
      fx.slowMs = 0;
    }
  });

  it("a resumed crawl that lands on a worker without the saved progress starts over and says so", async () => {
    for (const w of workers) await w.stop("SIGTERM");
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worker2-"));
    fx.slowMs = 300;
    try {
      const hitsBefore = fx.hits.get("/slow/42") ?? 0;
      const first = await startWorker({ WORKER_ID: "worker-f" });
      const { id } = await (await user.post("/api/crawl", { url: fx.url + "/slow/42", confirmPermission: true, options: { ...slow, maxPages: 8 } })).json();
      await waitFor("some progress", async () => ((await job(id)).stats?.pagesCrawled ?? 0) >= 3);
      expect(await first.stop("SIGTERM")).toBe(0);
      expect((await job(id)).status).toBe("interrupted");

      // Another machine: same queue and bucket, its own (empty) scratch disk.
      await startWorker({ WORKER_ID: "worker-g", CRAWL_DATA_DIR: elsewhere });
      expect((await user.post(`/api/crawl/${id}/control`, { action: "resume" })).status).toBe(200);
      const finished = await untilStatus(id, ["completed", "failed", "cancelled"]);
      expect(finished.status).toBe("completed");
      expect(finished.stats.pagesCrawled).toBe(8);
      const logs = await pg.query<{ m: string }>("select data->>'message' as m from job_events where job_id = $1 and type = 'log'", [id]);
      expect(logs.map((l) => l.m)).toContain("The saved progress of this crawl is not available on this worker; starting again from the first page.");
      // It really did start over: the first page was requested a second time, and the archive is complete.
      expect((fx.hits.get("/slow/42") ?? 0) - hitsBefore).toBe(2);
      const link = (await user.get(`/api/crawl/${id}/download`)).headers.get("location")!;
      const names = new AdmZip(Buffer.from(await (await fetch(link)).arrayBuffer())).getEntries().map((e) => e.entryName);
      for (let n = 42; n <= 49; n++) expect(names, `slow/${n}`).toContain(`slow/${n}/index.html`);
      await user.del(`/api/crawl/${id}`);
    } finally {
      fx.slowMs = 0;
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("retention: a worker deletes ended crawls older than the limit — row, archive, reports, orphaned scratch files — and keeps recent ones", async () => {
    for (const w of workers) await w.stop("SIGTERM");
    await startWorker({ WORKER_ID: "worker-h" });
    const ids: string[] = [];
    for (const n of [80, 81]) {
      const { id } = await (await user.post("/api/crawl", { url: `${fx.url}/slow/${n}`, confirmPermission: true, options: { ...slow, maxDepth: 0 } })).json();
      expect((await untilStatus(id, ["completed", "failed", "cancelled"])).status).toBe("completed");
      ids.push(id);
    }
    const [expired, recent] = ids;
    expect(s3.objects()).toEqual(expect.arrayContaining([`jobs/${expired}/site.zip`, `jobs/${expired}/report/crawl-report.json`, `jobs/${recent}/site.zip`]));
    await workers.at(-1)!.stop("SIGTERM");

    // One crawl is two days old, the other is from just now.
    await pg.query("update crawl_jobs set created_at = now() - interval '2 days' where id = $1", [expired]);
    // A scratch directory whose job no longer exists, and one that belongs to an existing job.
    fs.mkdirSync(path.join(workerData, "00000000000000bb"), { recursive: true });
    fs.writeFileSync(path.join(workerData, "00000000000000bb", "state.json"), "{}");
    fs.mkdirSync(path.join(workerData, recent), { recursive: true });

    await startWorker({ WORKER_ID: "worker-i", CRAWL_RETENTION_HOURS: "24" });
    await waitFor("the expired crawl to be removed", async () => !(await row(expired)), 30000);
    await waitFor("the orphaned scratch directory to be removed", async () => !fs.existsSync(path.join(workerData, "00000000000000bb")), 30000);
    expect(s3.objects().filter((k) => k.startsWith(`jobs/${expired}/`))).toEqual([]);
    expect((await user.get(`/api/crawl/${expired}`)).status).toBe(404);
    for (const t of ["job_events", "job_commands", "auth_profiles"]) expect(await pg.query(`select count(*)::int as n from ${t} where job_id = $1`, [expired]), t).toEqual([{ n: 0 }]);

    expect((await job(recent)).status).toBe("completed");
    expect(s3.objects()).toContain(`jobs/${recent}/site.zip`);
    expect((await user.get(`/api/crawl/${recent}/download`)).status).toBe(302);
    expect(fs.existsSync(path.join(workerData, recent))).toBe(true);
    await user.del(`/api/crawl/${recent}`);
  });
});
