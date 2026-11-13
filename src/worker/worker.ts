import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { authProfiles, crawlJobs, jobCommands, jobEvents, loginSessions, workers, type CrawlJobRow } from "@/db/schema";
import { decryptSecret, encryptSecret, type AuthProfile } from "@/lib/crawler/auth";
import { openSavedSessionForWorker, invalidateSavedSession, touchSavedSession } from "@/lib/server/login-profiles";
import { LoginBrowserManager } from "./login-browser-manager";
import { redactUrl } from "@/lib/crawler/api-discovery";
import { CombinedCrawler } from "@/lib/crawler/combined";
import { Crawler, type AuthHooks, type CrawlRunner } from "@/lib/crawler/engine";
import type { InteractiveLogin, LoginInput, SessionState } from "@/lib/crawler/interactive-login";
import { sanitizeOptions, type CrawlResult, type CrawlStats, type LogEvent } from "@/lib/crawler/types";
import { allowPrivateNetworks, DATA_DIR, jobDir, limits } from "@/lib/server/config";
import { ID_RE } from "@/lib/server/errors";
import { deleteJobData, REPORT_FILES } from "@/lib/server/jobs";
import { archiveKey, getStore, reportKey, sha256File } from "@/lib/server/storage";

/**
 * The persistent crawl worker.
 *
 * It is the only component that launches Chromium, holds decrypted credentials or writes archives.
 * All communication with the web tier goes through PostgreSQL:
 *
 *   web  -> worker   crawl_jobs (status "queued"), job_commands (pause / resume / cancel / sign-in input)
 *   worker -> web    crawl_jobs (status, stats, heartbeat), job_events (log lines, completion),
 *                    auth_profiles (status), login_sessions (encrypted screenshots)
 *
 * Jobs are claimed with FOR UPDATE SKIP LOCKED, so several workers can share one queue. A job whose
 * worker stops heart-beating is marked "interrupted" and can be resumed from its saved state.
 */

interface LiveJob {
  id: string;
  ownerId: string;
  runner: CrawlRunner;
  pending: { type: string; data: unknown }[];
  stats: CrawlStats | null;
  statsDirty: boolean;
  profileStatus: Map<string, string>;
  logins: Map<string, { login: InteractiveLogin; timer: NodeJS.Timeout; busy: boolean; lastHash: string }>;
  credentialsCleared: boolean;
}

export interface WorkerOptions {
  id?: string;
  maxJobs?: number;
  pollMs?: number;
  info?: Record<string, unknown>;
  log?: (msg: string) => void;
}

const HEARTBEAT_MS = 5000;
/** A running job whose worker has not heart-beaten for this long is considered orphaned. */
const STALE_SECONDS = Math.max(15, Number(process.env.WORKER_STALE_SECONDS) || 45);

export class CrawlWorker {
  readonly id: string;
  private live = new Map<string, LiveJob>();
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private ticking = false;
  private flushing = false;
  private maxJobs: number;
  private pollMs: number;
  private log: (msg: string) => void;
  private settled: Promise<void>[] = [];
  /** "Login with Browser" windows of reusable profiles (independent of any crawl job). */
  private loginBrowser: LoginBrowserManager;

  constructor(private o: WorkerOptions = {}) {
    this.id = o.id || `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    this.maxJobs = o.maxJobs ?? limits.maxConcurrentJobs;
    this.pollMs = o.pollMs ?? 500;
    this.log = o.log ?? ((m) => console.log(`[worker ${this.id}] ${m}`));
    this.loginBrowser = new LoginBrowserManager({ log: (m) => this.log(m) });
  }

  get activeJobs() {
    return this.live.size;
  }

  async start() {
    await fs.promises.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    await getStore().check();
    await db
      .insert(workers)
      .values({ id: this.id, info: this.o.info ?? {} })
      .onConflictDoUpdate({ target: workers.id, set: { startedAt: new Date(), heartbeatAt: new Date(), info: this.o.info ?? {} } });
    await this.recover();
    this.timers.push(setInterval(() => void this.tick(), this.pollMs));
    // A touch slower than the job loop: fetching the sign-in window's queue on its own connection
    // must never delay claiming a queued crawl.
    this.timers.push(setInterval(() => void this.loginBrowser.tick(), 750));
    this.timers.push(setInterval(() => void this.flush(), 400));
    this.timers.push(setInterval(() => void this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.janitor().catch((e) => this.log(`janitor: ${(e as Error).message}`)), 60000));
    void this.janitor().catch(() => {});
    this.log(`started (max ${this.maxJobs} concurrent jobs, storage: ${getStore().kind})`);
  }

  /** Graceful stop: running crawls save their state and become "interrupted" (resumable). */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.timers.forEach(clearInterval);
    for (const job of this.live.values()) job.runner.suspend();
    await Promise.race([Promise.allSettled(this.settled), new Promise((r) => setTimeout(r, 20000))]);
    await this.flush();
    await this.loginBrowser.stop().catch(() => {});
    await db.delete(workers).where(eq(workers.id, this.id)).catch(() => {});
    this.log("stopped");
  }

  // ---------- recovery ----------

  /** Jobs that claim to be running but have no live worker behind them become resumable. */
  private async recover() {
    const mine = Array.from(this.live.keys());
    const rows = await db
      .update(crawlJobs)
      .set({ status: "interrupted", workerId: null, stopReason: "The worker stopped while this crawl was running. Resume to continue from the saved state." })
      .where(
        and(
          inArray(crawlJobs.status, ["running", "paused"]),
          or(
            isNull(crawlJobs.heartbeatAt),
            sql`${crawlJobs.heartbeatAt} < now() - make_interval(secs => ${STALE_SECONDS})`,
            // Claimed by this worker id, but not actually running in this process (it restarted).
            and(eq(crawlJobs.workerId, this.id), mine.length ? notInArray(crawlJobs.id, mine) : sql`true`),
          ),
        ),
      )
      .returning({ id: crawlJobs.id });
    if (rows.length) {
      this.log(`marked ${rows.length} orphaned job(s) as interrupted`);
      await db
        .update(loginSessions)
        .set({ status: "cancelled", message: "The worker restarted.", frame: null, finishedAt: new Date() })
        .where(and(inArray(loginSessions.jobId, rows.map((r) => r.id)), eq(loginSessions.status, "awaiting-user")));
    }
    await db.delete(workers).where(lt(workers.heartbeatAt, new Date(Date.now() - 10 * 60 * 1000)));
  }

  private async heartbeat() {
    try {
      await db.update(workers).set({ heartbeatAt: new Date(), info: { ...(this.o.info ?? {}), activeJobs: this.live.size } }).where(eq(workers.id, this.id));
      const ids = [...this.live.keys()];
      if (ids.length) await db.update(crawlJobs).set({ heartbeatAt: new Date() }).where(and(inArray(crawlJobs.id, ids), eq(crawlJobs.workerId, this.id)));
      await this.recover();
    } catch (e) {
      this.log(`heartbeat failed: ${(e as Error).message}`);
    }
  }

  /** Retention + removal of working directories whose job row is gone. */
  private async janitor() {
    const cutoff = new Date(Date.now() - limits.retentionHours * 3600 * 1000);
    const old = await db
      .select({ id: crawlJobs.id, hasZip: crawlJobs.hasZip, storage: crawlJobs.storage })
      .from(crawlJobs)
      .where(and(lt(crawlJobs.createdAt, cutoff), inArray(crawlJobs.status, ["completed", "cancelled", "failed", "interrupted"])))
      .limit(50);
    for (const row of old) {
      if (this.live.has(row.id)) continue;
      await deleteJobData(row);
    }
    // Commands are short-lived: anything older than an hour is stale whether or not it was handled.
    await db.delete(jobCommands).where(lt(jobCommands.createdAt, new Date(Date.now() - 3600 * 1000)));
    const entries = await fs.promises.readdir(DATA_DIR).catch(() => [] as string[]);
    const dirs = entries.filter((e) => ID_RE.test(e) && !this.live.has(e));
    if (!dirs.length) return;
    const known = new Set((await db.select({ id: crawlJobs.id }).from(crawlJobs).where(inArray(crawlJobs.id, dirs))).map((r) => r.id));
    for (const d of dirs) if (!known.has(d)) await fs.promises.rm(path.join(DATA_DIR, d), { recursive: true, force: true });
  }

  // ---------- queue ----------

  private async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      await this.processCommands();
      while (!this.stopping && this.live.size < this.maxJobs) {
        const row = await this.claim();
        if (!row) break;
        await this.launch(row);
      }
    } catch (e) {
      this.log(`tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async claim(): Promise<CrawlJobRow | null> {
    const res = await db.execute(sql`
      UPDATE crawl_jobs SET status = 'running', worker_id = ${this.id}, heartbeat_at = now(), started_at = coalesce(started_at, now())
      WHERE id = (SELECT id FROM crawl_jobs WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id`);
    const id = (res.rows[0] as { id?: string } | undefined)?.id;
    if (!id) return null;
    return (await db.select().from(crawlJobs).where(eq(crawlJobs.id, id)).limit(1))[0] ?? null;
  }

  private async fail(id: string, message: string) {
    await db.update(crawlJobs).set({ status: "failed", error: message, finishedAt: new Date(), workerId: null }).where(eq(crawlJobs.id, id));
    await db.insert(jobEvents).values({ jobId: id, type: "done", data: { status: "failed", error: message } });
    await this.wipeSecrets(id);
  }

  private async wipeSecrets(jobId: string) {
    await db
      .update(authProfiles)
      .set({ secret: null, sessionState: null, sessionSavedAt: null, sessionExpiresAt: null, clearedAt: new Date() })
      .where(and(eq(authProfiles.jobId, jobId), isNull(authProfiles.clearedAt)));
  }

  private hooks(job: () => LiveJob | undefined, jobId: string, profileId: string, savedProfileId?: string | null): AuthHooks {
    const ctx = `session:${profileId}`;
    return {
      /**
       * A reusable "Login with Browser" session that the owner attached to this crawl. It is
       * decrypted here only, used by the engine before anything else, and dropped as soon as the
       * site rejects it (the job then falls back to the profile's own login settings).
       */
      loadSavedProfile: savedProfileId
        ? async () => {
            const owner = job()?.ownerId;
            if (!owner) return null;
            const saved = await openSavedSessionForWorker(savedProfileId, owner).catch(() => null);
            if (!saved) return null;
            await touchSavedSession(savedProfileId).catch(() => {});
            return { state: saved.state, profileName: saved.profileName };
          }
        : undefined,
      onSavedProfileRejected: savedProfileId
        ? async (reason) => {
            await invalidateSavedSession(savedProfileId, reason === "expired" ? "expired" : "rejected").catch(() => {});
            job()?.pending.push({
              type: "log",
              data: { t: Date.now(), tag: "WARN", message: "The site rejected the saved login profile; it needs to be renewed with “Sign in again”. Signing in with this crawl's own settings." } satisfies LogEvent,
            });
          }
        : undefined,
      loadSession: async () => {
        const row = (await db.select({ s: authProfiles.sessionState, exp: authProfiles.sessionExpiresAt }).from(authProfiles).where(eq(authProfiles.id, profileId)).limit(1))[0];
        if (!row?.s || !row.exp || row.exp.getTime() < Date.now()) return null;
        try {
          return JSON.parse(decryptSecret(row.s, ctx)) as SessionState;
        } catch {
          return null;
        }
      },
      saveSession: async (state) => {
        if (job()?.credentialsCleared) return;
        await db
          .update(authProfiles)
          .set({ sessionState: encryptSecret(JSON.stringify(state), ctx), sessionSavedAt: new Date(), sessionExpiresAt: new Date(Date.now() + limits.sessionTtlHours * 3600 * 1000) })
          .where(and(eq(authProfiles.id, profileId), isNull(authProfiles.clearedAt)));
      },
      clearSession: async () => {
        await db.update(authProfiles).set({ sessionState: null, sessionSavedAt: null, sessionExpiresAt: null }).where(eq(authProfiles.id, profileId));
      },
      onInteractiveLogin: (login) => {
        const j = job();
        if (j) void this.exposeLogin(j, login);
        else void login.cancel("The crawl is no longer running.");
      },
    };
  }

  private async launch(row: CrawlJobRow) {
    const id = row.id;
    try {
      if (!row.ownerId) return await this.fail(id, "This job has no owner and cannot be run.");
      const dir = jobDir(id);
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const resume = row.resume && fs.existsSync(path.join(dir, "state.json"));
      // Progress is saved on the worker's own disk. If this worker does not have it (another machine picked the
      // job up, or the disk was wiped), the crawl starts over rather than failing; the owner is told in the log.
      const startOver = row.resume && !resume && row.mode !== "combined";
      if (startOver) {
        await fs.promises.rm(dir, { recursive: true, force: true });
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      }

      const profileRows = await db.select().from(authProfiles).where(eq(authProfiles.jobId, id)).orderBy(asc(authProfiles.position));
      const profiles: AuthProfile[] = [];
      for (const p of profileRows) {
        if (!p.secret) return await this.fail(id, "The login credentials of this crawl were cleared; it cannot run.");
        const parsed = JSON.parse(decryptSecret(p.secret, `profile:${p.id}`)) as AuthProfile;
        // The row id is authoritative; a tampered envelope cannot rebind a profile.
        profiles.push({ ...parsed, id: p.id });
      }
      if (row.mode !== "public" && profiles.length === 0) return await this.fail(id, "This authenticated crawl has no login profile.");

      const opts = sanitizeOptions(row.options);
      const common = { workDir: dir, allowPrivateNetworks: allowPrivateNetworks(), interactiveLoginTimeoutMs: limits.interactiveLoginMinutes * 60 * 1000 };
      const getJob = () => this.live.get(id);
      let runner: CrawlRunner;
      if (row.mode === "combined") {
        // A combined crawl restarts from the beginning after an interruption (per-profile state is not merged back).
        if (row.resume) await fs.promises.rm(path.join(dir, "profiles"), { recursive: true, force: true });
        runner = new CombinedCrawler(row.url, opts, { ...common, profiles, hooksFor: (p) => this.hooks(getJob, id, p.id) });
      } else {
        const profile = profiles[0];
        runner = new Crawler(row.url, opts, { ...common, resume, authProfile: profile, authHooks: profile ? this.hooks(getJob, id, profile.id, profileRows[0]?.savedProfileId) : undefined });
      }
      const job: LiveJob = { id, ownerId: row.ownerId, runner, pending: [], stats: null, statsDirty: false, profileStatus: new Map(), logins: new Map(), credentialsCleared: false };
      this.live.set(id, job);
      if (startOver) job.pending.push({ type: "log", data: { t: Date.now(), tag: "WARN", message: "The saved progress of this crawl is not available on this worker; starting again from the first page." } satisfies LogEvent });
      if (row.resume) await db.update(crawlJobs).set({ resume: false, stopReason: null }).where(eq(crawlJobs.id, id));

      runner.on("log", (l: LogEvent) => job.pending.push({ type: "log", data: l }));
      runner.on("stats", (s: CrawlStats) => {
        job.stats = s;
        job.statsDirty = true;
      });
      runner.on("status", (s: string) => {
        job.pending.push({ type: "status", data: s });
        job.statsDirty = true;
      });
      const done = runner
        .run()
        .then((result) => this.finish(job, result))
        .catch(async (e: Error) => {
          this.log(`job ${id} crashed: ${e.message}`);
          await this.finish(job, { status: "failed", error: "Crawl failed.", stats: job.stats ?? runner.getStats() });
        })
        .finally(() => this.live.delete(id));
      this.settled.push(done);
      void done.finally(() => (this.settled = this.settled.filter((p) => p !== done)));
    } catch (e) {
      this.log(`job ${id} could not start: ${(e as Error).message}`);
      this.live.delete(id);
      await this.fail(id, "The crawl could not be started.").catch(() => {});
    }
  }

  // ---------- worker -> web ----------

  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const job of this.live.values()) await this.flushJob(job);
    } catch (e) {
      this.log(`flush failed: ${(e as Error).message}`);
    } finally {
      this.flushing = false;
    }
  }

  private async flushJob(job: LiveJob) {
    if (job.pending.length) {
      const batch = job.pending.splice(0, 200);
      await db.insert(jobEvents).values(batch.map((e) => ({ jobId: job.id, type: e.type, data: e.data as object })));
    }
    if (job.statsDirty && job.stats) {
      job.statsDirty = false;
      const s = job.stats;
      const status = job.runner.status;
      // Final states are written by finish() together with the archive metadata.
      if (status === "running" || status === "paused") {
        await db.update(crawlJobs).set({ stats: s, status, stopReason: s.stopReason ?? null, heartbeatAt: new Date() }).where(and(eq(crawlJobs.id, job.id), eq(crawlJobs.workerId, this.id)));
      }
      for (const p of s.profiles ?? []) {
        if (job.credentialsCleared || job.profileStatus.get(p.profileId) === p.status) continue;
        job.profileStatus.set(p.profileId, p.status);
        await db.update(authProfiles).set({ status: p.status }).where(and(eq(authProfiles.id, p.profileId), eq(authProfiles.jobId, job.id)));
      }
    }
  }

  private async finish(job: LiveJob, result: CrawlResult) {
    const id = job.id;
    for (const l of job.logins.values()) clearInterval(l.timer);
    let zipBytes = 0;
    let zipSha256: string | null = null;
    let hasZip = false;
    let error = result.error ?? null;
    let status = result.status;
    const store = getStore();
    try {
      if (result.reportDir) {
        for (const [file, type] of Object.entries(REPORT_FILES)) {
          const full = path.join(result.reportDir, file);
          if (fs.existsSync(full)) await store.putFile(reportKey(id, file), full, type);
        }
      }
      if (result.zipPath && fs.existsSync(result.zipPath)) {
        zipBytes = (await fs.promises.stat(result.zipPath)).size;
        zipSha256 = await sha256File(result.zipPath);
        await store.putFile(archiveKey(id), result.zipPath, "application/zip", { move: true, sha256: zipSha256 });
        hasZip = true;
      }
    } catch (e) {
      this.log(`job ${id}: storing the archive failed: ${(e as Error).message}`);
      status = "failed";
      error = "The archive was created but could not be stored.";
      hasZip = false;
    }
    await this.flushJob(job).catch(() => {});
    const final = status === "completed" || status === "cancelled" || status === "failed";
    await db
      .update(crawlJobs)
      .set({
        status,
        stats: { ...result.stats, status },
        error,
        stopReason: status === "interrupted" ? "The worker stopped while this crawl was running. Resume to continue from the saved state." : (result.stats.stopReason ?? null),
        hasZip,
        zipBytes,
        zipSha256,
        zipEntries: result.zipEntries ?? null,
        storage: hasZip ? store.kind : null,
        storageKey: hasZip ? archiveKey(id) : null,
        finishedAt: final ? new Date() : null,
        workerId: null,
      })
      .where(eq(crawlJobs.id, id));
    await db
      .update(loginSessions)
      .set({ status: "cancelled", frame: null, finishedAt: new Date() })
      .where(and(eq(loginSessions.jobId, id), eq(loginSessions.status, "awaiting-user")));
    if (final) {
      // Credentials and saved browser sessions do not outlive the crawl they were entered for.
      await this.wipeSecrets(id);
      await db
        .update(authProfiles)
        .set({ status: job.credentialsCleared ? "not-configured" : status === "completed" ? "completed" : status === "failed" && /log ?in|authenticat|credential/i.test(error ?? "") ? "authentication-failed" : sql`${authProfiles.status}` })
        .where(eq(authProfiles.jobId, id));
      await fs.promises.rm(jobDir(id), { recursive: true, force: true }).catch(() => {});
      // Keep the tail of the log for the history view.
      await db.execute(sql`DELETE FROM job_events WHERE job_id = ${id} AND id < (SELECT coalesce(max(id), 0) - 500 FROM job_events WHERE job_id = ${id})`);
    }
    await db.insert(jobEvents).values({ jobId: id, type: "done", data: { status, error, zipBytes } });
  }

  // ---------- interactive sign-in ----------

  private async exposeLogin(job: LiveJob, login: InteractiveLogin) {
    const sid = login.id;
    try {
      await db.insert(loginSessions).values({ id: sid, jobId: job.id, profileId: login.profileId, ownerId: job.ownerId, reason: login.reason, status: "awaiting-user", expiresAt: new Date(login.expiresAt), pageUrl: login.info().url ? redactUrl(login.info().url) : null });
    } catch (e) {
      this.log(`job ${job.id}: could not publish the sign-in session: ${(e as Error).message}`);
      await login.cancel("The sign-in session could not be published.");
      return;
    }
    const entry = { login, timer: null as unknown as NodeJS.Timeout, busy: false, lastHash: "" };
    const capture = async () => {
      if (entry.busy || login.status !== "awaiting-user") return;
      entry.busy = true;
      try {
        const jpeg = await login.frame();
        if (!jpeg) return;
        const hash = crypto.createHash("sha1").update(jpeg).digest("hex");
        if (hash === entry.lastHash) return;
        entry.lastHash = hash;
        // Screenshots of a sign-in page are sensitive: encrypted at rest, bound to this session, deleted when it ends.
        await db
          .update(loginSessions)
          .set({ frame: encryptSecret(jpeg, `login-frame:${sid}`), frameSeq: sql`${loginSessions.frameSeq} + 1`, pageUrl: redactUrl(login.info().url || "about:blank") })
          .where(and(eq(loginSessions.id, sid), eq(loginSessions.status, "awaiting-user")));
      } catch {
        /* next tick */
      } finally {
        entry.busy = false;
      }
    };
    entry.timer = setInterval(() => void capture(), 600);
    job.logins.set(sid, entry);
    void capture();
    login.onStatus((s) => {
      if (s === "awaiting-user") return;
      clearInterval(entry.timer);
      job.logins.delete(sid);
      void db
        .update(loginSessions)
        .set({ status: s, message: s === "authenticated" ? null : (login.error ?? null), frame: null, finishedAt: new Date() })
        .where(eq(loginSessions.id, sid))
        .catch(() => {});
    });
    // The session may already have ended while the row was being written.
    if (login.status !== "awaiting-user") {
      clearInterval(entry.timer);
      job.logins.delete(sid);
      await db.update(loginSessions).set({ status: login.status, message: login.error ?? null, frame: null, finishedAt: new Date() }).where(eq(loginSessions.id, sid));
    }
  }

  // ---------- web -> worker ----------

  private async processCommands() {
    const ids = [...this.live.keys()];
    if (!ids.length) return;
    const cmds = await db
      .select()
      .from(jobCommands)
      .where(and(inArray(jobCommands.jobId, ids), isNull(jobCommands.processedAt)))
      .orderBy(asc(jobCommands.id))
      .limit(200);
    for (const c of cmds) {
      const job = this.live.get(c.jobId);
      let result = "ok";
      try {
        if (job) result = (await this.execute(job, c.type, c.payload)) ?? "ok";
        else result = "job not live";
      } catch (e) {
        result = `error: ${(e as Error).message.slice(0, 200)}`;
      }
      // The payload (possibly typed text) is dropped as soon as the command has been handled.
      await db.update(jobCommands).set({ processedAt: new Date(), payload: null, result }).where(eq(jobCommands.id, c.id));
    }
  }

  private async execute(job: LiveJob, type: string, payload: string | null): Promise<string | void> {
    switch (type) {
      case "pause":
        job.runner.pause();
        return;
      case "cancel":
        job.runner.cancel();
        return;
      case "resume": {
        // Reauthentication can take a while (or wait for the user); never block the command loop on it.
        void job.runner.resumeCrawl().catch((e: Error) => job.pending.push({ type: "log", data: { t: Date.now(), tag: "WARN", message: e.message } satisfies LogEvent }));
        return;
      }
      case "clear-credentials":
        job.credentialsCleared = true;
        for (const l of job.logins.values()) void l.login.cancel("Credentials were cleared.");
        job.runner.cancel();
        return;
      case "login-confirm":
      case "login-cancel": {
        const { sid } = JSON.parse(payload ?? "{}") as { sid?: string };
        const entry = sid ? job.logins.get(sid) : undefined;
        if (!entry) return "no such sign-in session";
        if (type === "login-cancel") {
          await entry.login.cancel("The sign-in was cancelled by the user.");
          return;
        }
        const r = await entry.login.confirm();
        if (!r.ok) await db.update(loginSessions).set({ message: r.message ?? "Sign-in is not complete yet." }).where(and(eq(loginSessions.id, sid!), eq(loginSessions.status, "awaiting-user")));
        return r.ok ? "ok" : "not authenticated yet";
      }
      case "login-input": {
        const { sid, event } = JSON.parse(decryptSecret(payload ?? "", `cmd:${job.id}`)) as { sid: string; event: LoginInput };
        const entry = job.logins.get(sid);
        if (!entry) return "no such sign-in session";
        await entry.login.input(event);
        entry.lastHash = "";
        return;
      }
      default:
        return "unknown command";
    }
  }
}
