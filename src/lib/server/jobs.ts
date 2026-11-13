import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { authProfiles, crawlJobs, jobCommands, jobEvents, loginSessions, workers, type AuthProfileRow, type CrawlJobRow, type LoginSessionRow } from "@/db/schema";
import { AuthConfigurationError, authenticatedCrawlingEnabled, decryptSecretBytes, encryptSecret, usernameHint, validateAuthProfiles, type AuthProfile } from "@/lib/crawler/auth";
import { markSavedProfilesUsed, resolveSavedProfilesForCrawl } from "./login-profiles";
import { parseLoginInput, LoginInputError } from "@/lib/crawler/interactive-login";
import { assertPublicUrl, SsrfError } from "@/lib/crawler/security";
import { sanitizeOptions } from "@/lib/crawler/types";
import { allowPrivateNetworks, limits } from "./config";
import { ApiError, ID_RE } from "./errors";
import { archiveKey, getStore, reportKey } from "./storage";
import { rateLimit, type SessionUser } from "./users";

/**
 * Web-tier job service. It only talks to PostgreSQL and the archive store — never to Chromium or
 * the crawler engine — so it can run on a serverless platform. Every function takes the signed-in
 * user and scopes its queries by `owner_id`; a job that belongs to someone else is indistinguishable
 * from a job that does not exist (404).
 */

export const ACTIVE = ["queued", "running", "paused"] as const;
const FINAL = ["completed", "cancelled", "failed"] as const;

export const REPORT_FILES: Record<string, string> = {
  "crawl-report.html": "text/html; charset=utf-8",
  "crawl-report.json": "application/json",
  "failed-urls.txt": "text/plain; charset=utf-8",
  "discovered-urls.txt": "text/plain; charset=utf-8",
  "assets-manifest.json": "application/json",
  "api-discovery.json": "application/json",
  "combined-report.json": "application/json",
  "access-matrix.json": "application/json",
  "access-matrix.csv": "text/csv; charset=utf-8",
};

export function assertJobId(id: string): string {
  if (!ID_RE.test(id)) throw new ApiError(404, "Job not found");
  return id;
}

/** What a client may see of a job. Worker ids, storage keys and the owner id stay server-side. */
export function publicJob(r: CrawlJobRow) {
  return {
    id: r.id,
    url: r.url,
    status: r.status,
    mode: r.mode,
    options: r.options,
    stats: r.stats,
    error: r.error,
    stopReason: r.stopReason,
    hasZip: r.hasZip,
    zipBytes: r.zipBytes,
    zipSha256: r.zipSha256,
    zipEntries: r.zipEntries,
    downloadCount: r.downloadCount,
    lastDownloadedAt: r.lastDownloadedAt,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

export function publicProfile(p: AuthProfileRow) {
  return {
    id: p.id,
    name: p.name,
    method: p.method,
    loginOrigin: p.loginOrigin,
    usernameHint: p.usernameHint,
    status: p.status,
    credentialsStored: !!p.secret,
    sessionStored: !!p.sessionState,
    sessionSavedAt: p.sessionSavedAt,
    sessionExpiresAt: p.sessionExpiresAt,
    clearedAt: p.clearedAt,
  };
}

export function publicLogin(s: LoginSessionRow) {
  return { id: s.id, profileId: s.profileId, reason: s.reason, status: s.status, message: s.message, pageUrl: s.pageUrl, frameSeq: s.frameSeq, createdAt: s.createdAt, expiresAt: s.expiresAt, finishedAt: s.finishedAt };
}

/** The single ownership gate: returns the row only when it belongs to `user`. */
export async function ownedJob(user: SessionUser, id: string): Promise<CrawlJobRow> {
  assertJobId(id);
  const rows = await db.select().from(crawlJobs).where(and(eq(crawlJobs.id, id), eq(crawlJobs.ownerId, user.id))).limit(1);
  if (!rows[0]) throw new ApiError(404, "Job not found");
  return rows[0];
}

export async function workerOnline(): Promise<boolean> {
  const rows = await db.select({ id: workers.id }).from(workers).where(gt(workers.heartbeatAt, new Date(Date.now() - 30000))).limit(1);
  return rows.length > 0;
}

interface CreateBody {
  url?: unknown;
  options?: unknown;
  confirmPermission?: unknown;
  authProfiles?: unknown;
  authMode?: unknown;
  /** Ids of reusable "Login with Browser" profiles (owner-scoped, must match the crawled site). */
  savedProfileIds?: unknown;
}

export async function createCrawl(user: SessionUser, body: CreateBody): Promise<{ id: string; ids: string[]; mode: string; workerOnline: boolean; attachedProfiles: string[] }> {
  if (body.confirmPermission !== true) throw new ApiError(400, "You must confirm that you own the website or have permission to archive it.");
  if (typeof body.url !== "string" || !body.url.trim() || body.url.length > 2048) throw new ApiError(400, "Please enter a website URL.");
  let url = body.url.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  try {
    await assertPublicUrl(url, allowPrivateNetworks());
  } catch (e) {
    if (e instanceof SsrfError) throw new ApiError(400, `This address is not allowed: ${e.message}`);
    throw e;
  }

  // Login profiles: ids are always generated here; anything the client sent as an id is discarded.
  let profiles: ReturnType<typeof validateAuthProfiles> = [];
  if (body.authProfiles !== undefined) {
    if (!authenticatedCrawlingEnabled()) throw new AuthConfigurationError("Authenticated crawling is disabled: set CRAWLER_CREDENTIAL_ENCRYPTION_KEY to a random 32-byte key (hex or base64).", 503);
    if (!Array.isArray(body.authProfiles)) throw new ApiError(400, "authProfiles must be a list.");
    profiles = validateAuthProfiles(body.authProfiles.map((p, i) => (p && typeof p === "object" ? { ...(p as object), id: `p${i + 1}` } : p)));
    for (const p of profiles) {
      p.id = crypto.randomBytes(8).toString("hex");
      try {
        await assertPublicUrl(p.loginUrl, allowPrivateNetworks());
      } catch (e) {
        if (e instanceof SsrfError) throw new ApiError(400, `The login URL of "${p.name}" is not allowed: ${e.message}`);
        throw e;
      }
    }
  }
  // Reusable "Login with Browser" profiles: owner-scoped, and only for the site they were saved for.
  const saved = await resolveSavedProfilesForCrawl(user, url, body.savedProfileIds);
  if (saved.attached.length && !authenticatedCrawlingEnabled()) {
    throw new AuthConfigurationError("Saved logins are disabled: set CRAWLER_CREDENTIAL_ENCRYPTION_KEY on the web app and the worker.", 503);
  }
  for (const attached of saved.attached) {
    try {
      await assertPublicUrl(attached.loginUrl, allowPrivateNetworks());
    } catch (e) {
      if (e instanceof SsrfError) throw new ApiError(400, `The sign-in page of “${attached.name}” is not allowed: ${e.message}`);
      throw e;
    }
  }

  const combined = body.authMode === "combined";
  if (combined && profiles.length < 2) throw new ApiError(400, "Combined discovery needs at least two login profiles.");
  if (combined && saved.attached.length) throw new ApiError(400, "Combined discovery needs its own login profiles; saved logins are attached one crawl per profile.");
  // A saved login is a login profile too: with no manual profiles the crawl becomes authenticated.
  if (saved.attached.length && profiles.length > 0) throw new ApiError(400, "Attach either a saved login or a crawl-specific login for this site, not both.");
  const mode = saved.attached.length ? "authenticated" : profiles.length === 0 ? "public" : combined ? "combined" : "authenticated";
  const jobCount = mode === "authenticated" ? (saved.attached.length || profiles.length) : 1;

  await rateLimit(`crawl:${user.id}`, limits.startsPerMinute, 60, `Too many crawls started. Limit: ${limits.startsPerMinute} per minute.`);
  const active = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(crawlJobs)
    .where(and(eq(crawlJobs.ownerId, user.id), inArray(crawlJobs.status, [...ACTIVE])));
  if ((active[0]?.n ?? 0) + jobCount > limits.maxActiveJobsPerUser) {
    throw new ApiError(429, `You can run at most ${limits.maxActiveJobsPerUser} crawls at a time. Wait for one to finish.`);
  }
  const used = await db.select({ total: sql<number>`coalesce(sum(${crawlJobs.zipBytes}), 0)::float8` }).from(crawlJobs).where(eq(crawlJobs.ownerId, user.id));
  if ((used[0]?.total ?? 0) >= limits.storageQuotaBytes) throw new ApiError(507, "Your storage quota is used up. Delete old downloads first.");

  const raw = body.options && typeof body.options === "object" ? (body.options as Record<string, unknown>) : {};
  // Signed-in crawls render every page in one browser context; keep the load on the site modest.
  const authenticated = profiles.length > 0 || saved.attached.length > 0;
  const opts = sanitizeOptions(authenticated ? { ...raw, concurrency: Math.min(2, Number(raw.concurrency) || 2) } : raw);

  // A saved login becomes an ordinary per-crawl login profile (method "manual"), so the existing
  // queue, worker, session reuse, expiry and cancellation paths apply unchanged. Only the reference
  // to the reusable profile is extra.
  const savedProfiles: AuthProfile[] = saved.attached.map((a) => ({
    id: crypto.randomBytes(8).toString("hex"),
    name: a.name,
    loginUrl: a.loginUrl,
    username: "",
    password: "",
    method: "manual",
    ...(a.authenticatedSelector ? { authenticatedSelector: a.authenticatedSelector } : {}),
  }));
  const allProfiles = [...profiles, ...savedProfiles];
  const savedByProfileId = new Map(saved.attached.map((a, i) => [savedProfiles[i].id, a.id]));

  const ids: string[] = [];
  await db.transaction(async (tx) => {
    const groups = mode === "authenticated" ? allProfiles.map((p) => [p]) : [allProfiles];
    for (const group of groups) {
      const id = crypto.randomBytes(8).toString("hex");
      ids.push(id);
      await tx.insert(crawlJobs).values({ id, url, status: "queued", options: opts, ownerId: user.id, mode });
      let position = 0;
      for (const p of group) {
        await tx.insert(authProfiles).values({
          id: p.id,
          jobId: id,
          ownerId: user.id,
          position: position++,
          name: p.name,
          method: p.method,
          loginOrigin: new URL(p.loginUrl).origin,
          usernameHint: savedByProfileId.has(p.id) ? (saved.attached.find((a) => a.id === savedByProfileId.get(p.id))?.usernameHint ?? "") : usernameHint(p.username),
          // The whole profile (including the password) is one AES-256-GCM envelope bound to this row.
          secret: encryptSecret(JSON.stringify(p), `profile:${p.id}`),
          savedProfileId: savedByProfileId.get(p.id) ?? null,
        });
      }
    }
  });
  for (const p of allProfiles) {
    p.password = "";
    p.username = "";
  }
  if (saved.attached.length) await markSavedProfilesUsed(saved.attached.map((a) => a.id));
  return { id: ids[0], ids, mode, workerOnline: await workerOnline(), attachedProfiles: saved.attached.map((a) => a.name) };
}

export async function listJobs(user: SessionUser) {
  const rows = await db.select().from(crawlJobs).where(eq(crawlJobs.ownerId, user.id)).orderBy(desc(crawlJobs.createdAt)).limit(30);
  return rows.map(publicJob);
}

export async function profilesOf(user: SessionUser, jobId: string) {
  const rows = await db.select().from(authProfiles).where(and(eq(authProfiles.jobId, jobId), eq(authProfiles.ownerId, user.id))).orderBy(asc(authProfiles.position));
  return rows.map(publicProfile);
}

export async function loginSessionsOf(user: SessionUser, jobId: string, onlyActive = false) {
  const cond = [eq(loginSessions.jobId, jobId), eq(loginSessions.ownerId, user.id)];
  if (onlyActive) cond.push(eq(loginSessions.status, "awaiting-user"));
  const rows = await db.select().from(loginSessions).where(and(...cond)).orderBy(desc(loginSessions.createdAt)).limit(20);
  return rows.map(publicLogin);
}

export async function getJob(user: SessionUser, id: string) {
  const row = await ownedJob(user, id);
  const events = await db.select({ data: jobEvents.data }).from(jobEvents).where(and(eq(jobEvents.jobId, id), eq(jobEvents.type, "log"))).orderBy(desc(jobEvents.id)).limit(200);
  return {
    job: publicJob(row),
    logs: events.map((e) => e.data).reverse(),
    live: (ACTIVE as readonly string[]).includes(row.status),
    profiles: await profilesOf(user, id),
    loginSessions: await loginSessionsOf(user, id, true),
  };
}

export async function eventsAfter(jobId: string, afterId: number) {
  return db.select({ id: jobEvents.id, type: jobEvents.type, data: jobEvents.data }).from(jobEvents).where(and(eq(jobEvents.jobId, jobId), gt(jobEvents.id, afterId))).orderBy(asc(jobEvents.id)).limit(500);
}

export async function lastEventId(jobId: string): Promise<number> {
  const r = await db.select({ m: sql<number>`coalesce(max(${jobEvents.id}), 0)::float8` }).from(jobEvents).where(eq(jobEvents.jobId, jobId));
  return Number(r[0]?.m ?? 0);
}

async function enqueue(jobId: string, type: string, payload: string | null = null) {
  await db.insert(jobCommands).values({ jobId, type, payload });
}

export async function controlJob(user: SessionUser, id: string, action: unknown): Promise<{ status: string }> {
  const row = await ownedJob(user, id);
  if (action === "pause") {
    if (row.status !== "running") throw new ApiError(409, "This crawl is not running.");
    await enqueue(id, "pause");
    return { status: row.status };
  }
  if (action === "cancel") {
    if (row.status === "queued") {
      // Not picked up by a worker yet: cancel directly.
      const done = await db.update(crawlJobs).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(crawlJobs.id, id), eq(crawlJobs.ownerId, user.id), eq(crawlJobs.status, "queued"))).returning({ id: crawlJobs.id });
      if (done.length) {
        await wipeSecrets(id);
        return { status: "cancelled" };
      }
    }
    if (row.status !== "running" && row.status !== "paused" && row.status !== "queued") throw new ApiError(409, "This crawl is not running.");
    await enqueue(id, "cancel");
    return { status: row.status };
  }
  if (action === "resume") {
    if (row.status === "paused") {
      await enqueue(id, "resume");
      return { status: row.status };
    }
    if (row.status !== "interrupted") throw new ApiError(409, "Only paused or interrupted crawls can be resumed.");
    const active = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(crawlJobs)
      .where(and(eq(crawlJobs.ownerId, user.id), inArray(crawlJobs.status, [...ACTIVE])));
    if ((active[0]?.n ?? 0) >= limits.maxActiveJobsPerUser) throw new ApiError(429, "Too many crawls are running.");
    const done = await db
      .update(crawlJobs)
      .set({ status: "queued", resume: true, error: null, workerId: null })
      .where(and(eq(crawlJobs.id, id), eq(crawlJobs.ownerId, user.id), eq(crawlJobs.status, "interrupted")))
      .returning({ id: crawlJobs.id });
    if (!done.length) throw new ApiError(409, "Only paused or interrupted crawls can be resumed.");
    return { status: "queued" };
  }
  throw new ApiError(400, "action must be pause, resume or cancel");
}

/** Removes stored credentials and saved browser sessions of a job (rows stay as an audit trail). */
async function wipeSecrets(jobId: string) {
  await db
    .update(authProfiles)
    .set({ secret: null, sessionState: null, sessionSavedAt: null, sessionExpiresAt: null, clearedAt: new Date() })
    .where(and(eq(authProfiles.jobId, jobId), isNull(authProfiles.clearedAt)));
}

export async function clearCredentials(user: SessionUser, id: string) {
  const row = await ownedJob(user, id);
  const cleared = await db
    .update(authProfiles)
    .set({ secret: null, sessionState: null, sessionSavedAt: null, sessionExpiresAt: null, clearedAt: new Date(), status: "not-configured" })
    .where(and(eq(authProfiles.jobId, id), eq(authProfiles.ownerId, user.id)))
    .returning({ id: authProfiles.id });
  await db
    .update(loginSessions)
    .set({ frame: null })
    .where(and(eq(loginSessions.jobId, id), eq(loginSessions.ownerId, user.id)));
  const live = (ACTIVE as readonly string[]).includes(row.status);
  // The worker holds the decrypted profile and the live browser session in memory: end them too.
  if (live) await enqueue(id, "clear-credentials");
  if (row.status === "interrupted" && cleared.length) {
    await db.update(crawlJobs).set({ stopReason: "Credentials were cleared; this crawl can no longer be resumed." }).where(and(eq(crawlJobs.id, id), eq(crawlJobs.ownerId, user.id)));
  }
  return { ok: true, credentialsRemoved: true, profiles: cleared.length, activeSessionCancelled: live };
}

export async function removeJob(user: SessionUser, id: string) {
  const row = await ownedJob(user, id);
  if (row.status === "running" || row.status === "paused") {
    await enqueue(id, "cancel");
    throw new ApiError(409, "The crawl was still running and is being cancelled. Try deleting again in a moment.");
  }
  await deleteJobData(row);
}

/** Deletes stored objects and the row (cascades to profiles, sessions, commands, events). The worker's janitor removes its working directory. */
export async function deleteJobData(row: Pick<CrawlJobRow, "id" | "hasZip" | "storage">) {
  const keys = [archiveKey(row.id), ...Object.keys(REPORT_FILES).map((f) => reportKey(row.id, f))];
  await getStore().remove(keys).catch((e) => console.error("[storage] delete failed:", (e as Error).message));
  await db.delete(crawlJobs).where(eq(crawlJobs.id, row.id));
}

// ---------- downloads ----------

export function downloadName(row: CrawlJobRow): string {
  let host = "site";
  try {
    host = new URL(row.url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    /* keep default */
  }
  return `${host}-${row.id.slice(0, 8)}.zip`;
}

export async function recordDownload(user: SessionUser, id: string) {
  await db
    .update(crawlJobs)
    .set({ downloadCount: sql`${crawlJobs.downloadCount} + 1`, lastDownloadedAt: new Date() })
    .where(and(eq(crawlJobs.id, id), eq(crawlJobs.ownerId, user.id)));
}

// ---------- interactive sign-in ----------

async function ownedLogin(user: SessionUser, jobId: string, sid: string): Promise<LoginSessionRow> {
  await ownedJob(user, jobId);
  if (!ID_RE.test(sid)) throw new ApiError(404, "Sign-in session not found");
  const rows = await db
    .select()
    .from(loginSessions)
    .where(and(eq(loginSessions.id, sid), eq(loginSessions.jobId, jobId), eq(loginSessions.ownerId, user.id)))
    .limit(1);
  if (!rows[0]) throw new ApiError(404, "Sign-in session not found");
  return rows[0];
}

export async function loginSession(user: SessionUser, jobId: string, sid: string) {
  return publicLogin(await ownedLogin(user, jobId, sid));
}

/** Latest screenshot of the isolated sign-in browser (JPEG), decrypted only for its owner. */
export async function loginFrame(user: SessionUser, jobId: string, sid: string): Promise<{ jpeg: Buffer; seq: number } | null> {
  const s = await ownedLogin(user, jobId, sid);
  if (s.status !== "awaiting-user" || !s.frame) return null;
  return { jpeg: decryptSecretBytes(s.frame, `login-frame:${s.id}`), seq: s.frameSeq };
}

export async function loginAction(user: SessionUser, jobId: string, sid: string, body: Record<string, unknown>) {
  const s = await ownedLogin(user, jobId, sid);
  if (s.status !== "awaiting-user") throw new ApiError(409, "This sign-in session is no longer active.");
  await rateLimit(`login-input:${user.id}`, 1200, 60, "Too many input events.");
  if (body.action === "confirm" || body.action === "cancel") {
    await enqueue(jobId, `login-${body.action}`, JSON.stringify({ sid }));
    return { ok: true };
  }
  if (body.action === "input") {
    let event;
    try {
      event = parseLoginInput(body.event);
    } catch (e) {
      if (e instanceof LoginInputError) throw new ApiError(400, e.message);
      throw e;
    }
    // Typed text can be a password or a one-time code: it crosses the queue encrypted and is deleted once processed.
    await enqueue(jobId, "login-input", encryptSecret(JSON.stringify({ sid, event }), `cmd:${jobId}`));
    return { ok: true };
  }
  throw new ApiError(400, "action must be input, confirm or cancel");
}

export { FINAL };
