import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { authProfiles, crawlJobs, loginProfileCommands, loginSessions, savedLoginSessions, targetLoginProfiles, type SavedLoginSessionRow, type TargetLoginProfileRow } from "@/db/schema";
import { authenticatedCrawlingEnabled } from "@/lib/crawler/auth";
import type { SessionState } from "@/lib/crawler/interactive-login";
import {
  assertLoginUrlInScope,
  hostKey,
  hostMatchesScope,
  normalizeAddress,
  openSession,
  SAVED_PROFILE_STATUS_TEXT,
  SavedProfileError,
  sealSession,
  scopeSessionState,
  validateProfileInput,
  parseRequestCapture,
  type ProfileScope,
  type SavedProfileStatus,
} from "@/lib/crawler/saved-login";
import { assertPublicUrl, SsrfError } from "@/lib/crawler/security";
import { allowPrivateNetworks, limits } from "./config";
import { ApiError } from "./errors";
import { rateLimit, type SessionUser } from "./users";

/**
 * Owner-scoped storage and rules for reusable "Login with Browser" profiles.
 *
 * Every query is filtered by `owner_id`; a profile that belongs to somebody else is indistinguishable
 * from one that does not exist (404). Session material is only ever decrypted for the worker that is
 * about to use it (`openSavedSessionForWorker`) — no web route returns it.
 */

export interface PublicSavedProfile {
  id: string;
  name: string;
  targetHost: string;
  targetOrigin: string;
  matchSubdomains: boolean;
  startUrl: string;
  loginUrl: string | null;
  authenticatedSelector: string | null;
  usernameHint: string;
  status: SavedProfileStatus;
  statusLabel: string;
  statusMessage: string | null;
  hasSession: boolean;
  session: { capturedAt: string; expiresAt: string; lastValidatedAt: string | null; cookieCount: number; originCount: number } | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

const SESSION_STATUSES: SavedProfileStatus[] = ["active", "needs-request-capture", "session-expired", "session-rejected", "login-failed"];

/** What the owner may see of a profile. Never the stored session, never a cookie or token. */
export function publicSavedProfile(row: TargetLoginProfileRow, session?: SavedLoginSessionRow | null): PublicSavedProfile {
  const status = (SESSION_STATUSES as string[]).includes(row.status) ? (row.status as SavedProfileStatus) : "login-failed";
  const liveSession = session && !session.invalidatedAt && session.expiresAt.getTime() > Date.now();
  return {
    id: row.id,
    name: row.name,
    targetHost: row.targetHost,
    targetOrigin: row.targetOrigin,
    matchSubdomains: row.matchSubdomains,
    startUrl: row.startUrl,
    loginUrl: row.loginUrl,
    authenticatedSelector: row.authenticatedSelector,
    usernameHint: row.usernameHint,
    status: liveSession ? status : status === "active" ? "session-expired" : status,
    statusLabel: SAVED_PROFILE_STATUS_TEXT[liveSession ? status : status === "active" ? "session-expired" : status],
    statusMessage: row.statusMessage,
    hasSession: !!liveSession,
    session: liveSession
      ? {
          capturedAt: session.capturedAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
          lastValidatedAt: session.lastValidatedAt?.toISOString() ?? null,
          cookieCount: session.cookieCount,
          originCount: session.originCount,
        }
      : session
        ? { capturedAt: session.capturedAt.toISOString(), expiresAt: session.expiresAt.toISOString(), lastValidatedAt: session.lastValidatedAt?.toISOString() ?? null, cookieCount: session.cookieCount, originCount: session.originCount }
        : null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    useCount: row.useCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requireFeature(): void {
  if (!authenticatedCrawlingEnabled()) {
    throw new ApiError(503, "Saved logins are disabled: set CRAWLER_CREDENTIAL_ENCRYPTION_KEY to a random 32-byte key (hex or base64) on the web app and the worker.");
  }
}

async function assertAllowedUrl(url: string, what: string): Promise<void> {
  try {
    await assertPublicUrl(url, allowPrivateNetworks());
  } catch (e) {
    if (e instanceof SsrfError) throw new ApiError(400, `The ${what} is not allowed: ${e.message}`);
    throw e;
  }
}

function columnsOf(row: { startUrl: string; targetHost: string; targetOrigin: string; matchSubdomains: boolean }): ProfileScope {
  return { targetHost: row.targetHost, targetOrigin: row.targetOrigin, matchSubdomains: row.matchSubdomains };
}

/** The one ownership gate for saved profiles. */
export async function ownedSavedProfile(user: SessionUser, id: string): Promise<TargetLoginProfileRow> {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new ApiError(404, "Login profile not found");
  const rows = await db.select().from(targetLoginProfiles).where(and(eq(targetLoginProfiles.id, id), eq(targetLoginProfiles.ownerId, user.id))).limit(1);
  if (!rows[0]) throw new ApiError(404, "Login profile not found");
  return rows[0];
}

async function sessionOf(profileId: string, ownerId: string): Promise<SavedLoginSessionRow | null> {
  const rows = await db.select().from(savedLoginSessions).where(and(eq(savedLoginSessions.profileId, profileId), eq(savedLoginSessions.ownerId, ownerId))).limit(1);
  return rows[0] ?? null;
}

export async function listSavedProfiles(user: SessionUser, host?: string | null): Promise<PublicSavedProfile[]> {
  const rows = await db.select().from(targetLoginProfiles).where(eq(targetLoginProfiles.ownerId, user.id)).orderBy(desc(targetLoginProfiles.createdAt));
  const ids = rows.map((r) => r.id);
  const sessions = ids.length ? await db.select().from(savedLoginSessions).where(and(eq(savedLoginSessions.ownerId, user.id), inArray(savedLoginSessions.profileId, ids))) : [];
  const byId = new Map(sessions.map((s) => [s.profileId, s]));
  let profiles = rows.map((r) => publicSavedProfile(r, byId.get(r.id) ?? null));
  if (host) profiles = profiles.filter((p) => hostMatchesScope({ targetHost: p.targetHost, matchSubdomains: p.matchSubdomains }, host));
  return profiles;
}

export async function getSavedProfile(user: SessionUser, id: string): Promise<PublicSavedProfile> {
  const row = await ownedSavedProfile(user, id);
  return publicSavedProfile(row, await sessionOf(row.id, user.id));
}

/** True when a saved profile may be attached to a crawl of `url` (same site, never another site). */
export function profileMatchesUrl(profile: Pick<TargetLoginProfileRow, "targetHost" | "matchSubdomains">, url: string): boolean {
  return hostMatchesScope({ targetHost: profile.targetHost, matchSubdomains: profile.matchSubdomains }, url);
}

export async function createSavedProfile(user: SessionUser, body: unknown): Promise<PublicSavedProfile> {
  requireFeature();
  const input = validateProfileInput(body);
  const start = normalizeAddress(input.startUrl, "website address");
  await assertAllowedUrl(start.href, "website address");
  assertLoginUrlInScope(start.href, input.loginUrl, !!input.matchSubdomains);
  if (input.loginUrl) await assertAllowedUrl(input.loginUrl, "sign-in page address");

  const owned = await db.select({ n: sql<number>`count(*)::int` }).from(targetLoginProfiles).where(eq(targetLoginProfiles.ownerId, user.id));
  if ((owned[0]?.n ?? 0) >= limits.maxSavedProfiles) throw new ApiError(429, `You can save at most ${limits.maxSavedProfiles} login profiles. Delete one first.`);
  await rateLimit(`login-profile:${user.id}`, 30, 60, "Too many login profile changes. Try again in a minute.");

  const host = hostKey(start);
  const id = crypto.randomBytes(8).toString("hex");
  const now = new Date();
  const rows = await db
    .insert(targetLoginProfiles)
    .values({
      id,
      ownerId: user.id,
      name: input.name!,
      targetHost: host,
      targetOrigin: start.origin,
      matchSubdomains: !!input.matchSubdomains,
      startUrl: start.href,
      loginUrl: input.loginUrl || null,
      authenticatedSelector: input.authenticatedSelector || null,
      status: "login-failed",
      statusMessage: "No login saved yet. Use “Login with Browser” to sign in.",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return publicSavedProfile(rows[0], null);
}

export async function updateSavedProfile(user: SessionUser, id: string, body: unknown): Promise<PublicSavedProfile> {
  const row = await ownedSavedProfile(user, id);
  // Renaming and re-labelling only: the target site of an existing session must never change,
  // because the stored session is bound to it.
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "Invalid profile.");
  const b = body as Record<string, unknown>;
  const patch: Partial<typeof targetLoginProfiles.$inferInsert> = { updatedAt: new Date() };
  if (b.name !== undefined) {
    const parsed = validateProfileInput({ ...(b.startUrl === undefined ? {} : {}), name: b.name }, true);
    if (!parsed.name) throw new ApiError(400, "Give the login profile a name.");
    patch.name = parsed.name;
  }
  if (b.authenticatedSelector !== undefined) {
    const parsed = validateProfileInput({ authenticatedSelector: b.authenticatedSelector }, true);
    patch.authenticatedSelector = parsed.authenticatedSelector || null;
  }
  if (b.loginUrl !== undefined) {
    const parsed = validateProfileInput({ loginUrl: b.loginUrl }, true);
    assertLoginUrlInScope(row.startUrl, parsed.loginUrl, row.matchSubdomains);
    if (parsed.loginUrl) await assertAllowedUrl(parsed.loginUrl, "sign-in page address");
    patch.loginUrl = parsed.loginUrl || null;
  }
  if (b.startUrl !== undefined || b.matchSubdomains !== undefined) {
    throw new ApiError(400, "The website of a saved login cannot be changed. Create a new profile for a different site.");
  }
  const rows = await db.update(targetLoginProfiles).set(patch).where(and(eq(targetLoginProfiles.id, id), eq(targetLoginProfiles.ownerId, user.id))).returning();
  return publicSavedProfile(rows[0], await sessionOf(id, user.id));
}

export async function deleteSavedProfile(user: SessionUser, id: string): Promise<{ ok: true; deleted: true }> {
  await ownedSavedProfile(user, id);
  // Detach it from anything that used it: running jobs keep their own per-crawl copy and continue.
  await db.update(authProfiles).set({ savedProfileId: null }).where(and(eq(authProfiles.savedProfileId, id), eq(authProfiles.ownerId, user.id)));
  await db.delete(loginSessions).where(and(eq(loginSessions.savedProfileId, id), eq(loginSessions.ownerId, user.id)));
  await db.delete(targetLoginProfiles).where(and(eq(targetLoginProfiles.id, id), eq(targetLoginProfiles.ownerId, user.id)));
  return { ok: true, deleted: true };
}

/** Stores a freshly captured session. Called by the worker only, after "Use This Login" succeeded. */
export async function saveCapturedSession(profileId: string, ownerId: string, state: SessionState): Promise<{ cookieCount: number }> {
  const rows = await db.select().from(targetLoginProfiles).where(and(eq(targetLoginProfiles.id, profileId), eq(targetLoginProfiles.ownerId, ownerId))).limit(1);
  const profile = rows[0];
  if (!profile) throw new SavedProfileError("That login profile no longer exists.", 404);
  // Defence in depth: even if a caller hands over a wider capture, only this site's cookies are kept.
  const scopedState = scopeSessionState(columnsOf(profile), state);
  const sealed = sealSession(profile.id, ownerId, profile.targetHost, scopedState);
  if (sealed.cookieCount === 0) throw new SavedProfileError("No cookies for this website were captured; nothing was saved.");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + limits.savedSessionTtlHours * 3600 * 1000);
  await db
    .insert(savedLoginSessions)
    .values({ profileId: profile.id, ownerId, state: sealed.envelope, cookieCount: sealed.cookieCount, originCount: sealed.originCount, capturedAt: now, expiresAt, lastValidatedAt: now })
    .onConflictDoUpdate({
      target: savedLoginSessions.profileId,
      set: { state: sealed.envelope, cookieCount: sealed.cookieCount, originCount: sealed.originCount, capturedAt: now, expiresAt, lastValidatedAt: now, invalidatedAt: null, invalidatedReason: null },
    });
  await db
    .update(targetLoginProfiles)
    .set({ status: "active", statusMessage: null, updatedAt: now })
    .where(and(eq(targetLoginProfiles.id, profile.id), eq(targetLoginProfiles.ownerId, ownerId)));
  return { cookieCount: sealed.cookieCount };
}

/** Stores a session imported from a "Copy as cURL" request (the request-login fallback). */
export async function saveRequestCapture(user: SessionUser, profileId: string, capture: unknown): Promise<PublicSavedProfile> {
  requireFeature();
  const profile = await ownedSavedProfile(user, profileId);
  const scope = columnsOf(profile);
  let imported;
  try {
    imported = parseRequestCapture(capture, scope);
  } catch (e) {
    if (e instanceof SavedProfileError) throw new ApiError(e.status, e.message);
    throw e;
  }
  const sealed = sealSession(profile.id, user.id, profile.targetHost, imported.state);
  const now = new Date();
  await db
    .insert(savedLoginSessions)
    .values({ profileId: profile.id, ownerId: user.id, state: sealed.envelope, cookieCount: sealed.cookieCount, originCount: 0, capturedAt: now, expiresAt: new Date(now.getTime() + limits.savedSessionTtlHours * 3600 * 1000), lastValidatedAt: null })
    .onConflictDoUpdate({ target: savedLoginSessions.profileId, set: { state: sealed.envelope, cookieCount: sealed.cookieCount, originCount: 0, capturedAt: now, expiresAt: new Date(now.getTime() + limits.savedSessionTtlHours * 3600 * 1000), invalidatedAt: null, invalidatedReason: null } });
  await db.update(targetLoginProfiles).set({ status: "active", statusMessage: "Login imported from a browser request. It is used for the crawl; use “Login with Browser” to refresh it.", updatedAt: now }).where(and(eq(targetLoginProfiles.id, profile.id), eq(targetLoginProfiles.ownerId, user.id)));
  return getSavedProfile(user, profileId);
}

/** "Forget this login": removes the stored session and keeps the profile (name, site, selector). */
export async function clearSavedSession(user: SessionUser, profileId: string): Promise<PublicSavedProfile> {
  const profile = await ownedSavedProfile(user, profileId);
  await db.delete(savedLoginSessions).where(and(eq(savedLoginSessions.profileId, profile.id), eq(savedLoginSessions.ownerId, user.id)));
  await db
    .update(targetLoginProfiles)
    .set({ status: "login-failed", statusMessage: "No login saved. Use “Login with Browser” to sign in.", updatedAt: new Date() })
    .where(and(eq(targetLoginProfiles.id, profile.id), eq(targetLoginProfiles.ownerId, user.id)));
  await db.update(loginSessions).set({ frame: null }).where(and(eq(loginSessions.savedProfileId, profile.id), eq(loginSessions.ownerId, user.id)));
  return getSavedProfile(user, profileId);
}

// ---------- crawl integration ----------

export interface AttachedProfile {
  id: string;
  name: string;
  loginUrl: string;
  authenticatedSelector: string | null;
  usernameHint: string;
  targetHost: string;
  /** True when a stored session exists and has not been invalidated or expired. */
  hasSession: boolean;
}

/**
 * Resolves the saved profiles a user asked to attach to a crawl, and refuses anything that does not
 * belong to them or does not belong to the crawled site. This is the only place a client-supplied
 * profile id enters the crawl path.
 */
export async function resolveSavedProfilesForCrawl(user: SessionUser, url: string, ids: unknown): Promise<{ attached: AttachedProfile[]; states: Map<string, SessionState> }> {
  if (ids === undefined || ids === null) return { attached: [], states: new Map() };
  requireFeature();
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 5) throw new ApiError(400, "Select between 1 and 5 saved login profiles.");
  const unique = [...new Set(ids.map(String))];
  const rows = await db.select().from(targetLoginProfiles).where(and(eq(targetLoginProfiles.ownerId, user.id), inArray(targetLoginProfiles.id, unique)));
  if (rows.length !== unique.length) throw new ApiError(404, "Login profile not found");
  for (const row of rows) {
    if (!profileMatchesUrl(row, url)) {
      throw new ApiError(400, `The saved login “${row.name}” belongs to ${row.targetHost} and cannot be used for ${new URL(url).hostname}.`);
    }
  }
  const sessions = await db
    .select()
    .from(savedLoginSessions)
    .where(and(eq(savedLoginSessions.ownerId, user.id), inArray(savedLoginSessions.profileId, unique)));
  const states = new Map<string, SessionState>();
  const attached: AttachedProfile[] = [];
  for (const row of unique.map((id) => rows.find((r) => r.id === id)!)) {
    const s = sessions.find((x) => x.profileId === row.id);
    const live = !!s && !s.invalidatedAt && s.expiresAt.getTime() > Date.now();
    attached.push({ id: row.id, name: row.name, loginUrl: row.loginUrl ?? row.startUrl, authenticatedSelector: row.authenticatedSelector, usernameHint: row.usernameHint, targetHost: row.targetHost, hasSession: live });
  }
  return { attached, states };
}

/** Records that a saved login was just attached to a job (last-used timestamp + counter). */
export async function markSavedProfilesUsed(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db
    .update(targetLoginProfiles)
    .set({ lastUsedAt: new Date(), useCount: sql`${targetLoginProfiles.useCount} + 1` })
    .where(inArray(targetLoginProfiles.id, ids));
}

/** The site rejected a stored session: mark it so the UI offers "Sign in again" instead of a broken crawl. */
export async function invalidateSavedSession(profileId: string, reason: "expired" | "rejected"): Promise<void> {
  const now = new Date();
  await db
    .update(savedLoginSessions)
    .set({ invalidatedAt: now, invalidatedReason: reason })
    .where(eq(savedLoginSessions.profileId, profileId));
  await db
    .update(targetLoginProfiles)
    .set({
      status: reason === "expired" ? "session-expired" : "session-rejected",
      statusMessage: reason === "expired" ? "The site ended this session. Choose “Sign in again” to renew it." : "The site rejected this login. Sign in with the browser again.",
      updatedAt: now,
    })
    .where(eq(targetLoginProfiles.id, profileId));
}

/** Worker-side read: decrypts one stored session for the job that is about to use it. */
export async function openSavedSessionForWorker(profileId: string, ownerId: string): Promise<{ state: SessionState; profileName: string; targetHost: string } | null> {
  const rows = await db.select().from(targetLoginProfiles).where(and(eq(targetLoginProfiles.id, profileId), eq(targetLoginProfiles.ownerId, ownerId))).limit(1);
  const profile = rows[0];
  if (!profile) return null;
  const session = await sessionOf(profile.id, ownerId);
  if (!session || session.invalidatedAt || session.expiresAt.getTime() <= Date.now()) return null;
  try {
    const state = openSession(profile.id, ownerId, profile.targetHost, session.state);
    return { state, profileName: profile.name, targetHost: profile.targetHost };
  } catch {
    // AAD mismatch (moved row) or a rotated key: treat as unusable rather than guessing.
    await invalidateSavedSession(profile.id, "rejected").catch(() => {});
    return null;
  }
}

export async function touchSavedSession(profileId: string): Promise<void> {
  await db.update(savedLoginSessions).set({ lastValidatedAt: new Date() }).where(eq(savedLoginSessions.profileId, profileId));
}

// ---------- "Login with Browser" windows ----------

export interface BrowserLoginRow {
  id: string;
  savedProfileId: string;
  status: string;
  message: string | null;
  pageUrl: string | null;
  frameSeq: number;
  expiresAt: string;
  createdAt: string;
  /** Origins the worker refused to navigate to (the profile belongs to one site only). */
  blockedOrigins: string[];
}

/** `page_title` of a login window carries the refused origins as JSON; it never holds page text. */
function blockedOriginsOf(pageTitle: string | null): string[] {
  if (!pageTitle) return [];
  try {
    const v = JSON.parse(pageTitle);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}

export function publicBrowserLogin(s: {
  id: string;
  savedProfileId: string | null;
  status: string;
  message: string | null;
  pageUrl: string | null;
  pageTitle?: string | null;
  frameSeq: number;
  expiresAt: Date;
  createdAt: Date;
}): BrowserLoginRow {
  return {
    id: s.id,
    savedProfileId: s.savedProfileId ?? "",
    status: s.status,
    message: s.message,
    pageUrl: s.pageUrl,
    frameSeq: s.frameSeq,
    expiresAt: s.expiresAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    blockedOrigins: blockedOriginsOf(s.pageTitle ?? null),
  };
}

/** Opens a new "Login with Browser" window and queues the command that makes the worker open it. */
export async function startBrowserLogin(user: SessionUser, profileId: string, body: unknown): Promise<BrowserLoginRow> {
  requireFeature();
  const profile = await ownedSavedProfile(user, profileId);
  await rateLimit(`browser-login:${user.id}`, 10, 60, "Too many sign-in windows. Wait a minute.");
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const entry = b.entryUrl === undefined || b.entryUrl === null || b.entryUrl === "" ? profile.loginUrl || profile.startUrl : normalizeAddress(b.entryUrl, "sign-in page address").href;
  if (!hostMatchesScope(columnsOf(profile), entry)) throw new ApiError(400, `The sign-in page must be on ${profile.targetHost}.`);
  await assertAllowedUrl(entry, "sign-in page address");

  // One window at a time per profile: close any previous one instead of leaking browsers.
  await db
    .update(loginSessions)
    .set({ status: "cancelled", message: "Replaced by a newer sign-in window.", finishedAt: new Date(), frame: null })
    .where(and(eq(loginSessions.savedProfileId, profile.id), eq(loginSessions.ownerId, user.id), eq(loginSessions.status, "awaiting-user")));

  const sid = crypto.randomBytes(8).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + limits.browserLoginMinutes * 60 * 1000);
  const rows = await db
    .insert(loginSessions)
    .values({ id: sid, ownerId: user.id, savedProfileId: profile.id, reason: "manual-login", status: "awaiting-user", scope: "login-browser", expiresAt, createdAt: now, pageUrl: entry })
    .returning();
  await db.insert(loginProfileCommands).values({ sid, savedProfileId: profile.id, ownerId: user.id, type: "open", payload: JSON.stringify({ entryUrl: entry, authenticatedSelector: profile.authenticatedSelector }) });
  return publicBrowserLogin(rows[0]);
}

async function ownedBrowserLogin(user: SessionUser, sid: string) {
  if (!/^[a-f0-9]{16}$/.test(sid)) throw new ApiError(404, "Sign-in window not found");
  const rows = await db
    .select()
    .from(loginSessions)
    .where(and(eq(loginSessions.id, sid), eq(loginSessions.ownerId, user.id), eq(loginSessions.scope, "login-browser")))
    .limit(1);
  if (!rows[0]) throw new ApiError(404, "Sign-in window not found");
  return rows[0];
}

export async function getBrowserLogin(user: SessionUser, sid: string): Promise<{ session: BrowserLoginRow; profile: PublicSavedProfile }> {
  const row = await ownedBrowserLogin(user, sid);
  return { session: publicBrowserLogin(row), profile: await getSavedProfile(user, row.savedProfileId!) };
}

export async function browserLoginFrame(user: SessionUser, sid: string): Promise<{ jpeg: Buffer; seq: number } | null> {
  const row = await ownedBrowserLogin(user, sid);
  if (row.status !== "awaiting-user" || !row.frame) return null;
  const { decryptSecretBytes } = await import("@/lib/crawler/auth");
  return { jpeg: decryptSecretBytes(row.frame, `login-frame:${row.id}`), seq: row.frameSeq };
}

export async function browserLoginAction(user: SessionUser, sid: string, body: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
  const row = await ownedBrowserLogin(user, sid);
  if (row.status !== "awaiting-user") throw new ApiError(409, "This sign-in window is no longer open.");
  await rateLimit(`login-browser-input:${user.id}`, 1800, 60, "Too many input events.");
  const { parseLoginInput, LoginInputError } = await import("@/lib/crawler/interactive-login");
  const { encryptSecret } = await import("@/lib/crawler/auth");
  if (body.action === "confirm" || body.action === "cancel") {
    await db.insert(loginProfileCommands).values({ sid, savedProfileId: row.savedProfileId!, ownerId: user.id, type: body.action });
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
    // Anything typed can be a password or a one-time code: it crosses the queue encrypted and is
    // deleted by the worker as soon as it has been applied.
    await db.insert(loginProfileCommands).values({ sid, savedProfileId: row.savedProfileId!, ownerId: user.id, type: "input", payload: encryptSecret(JSON.stringify({ sid, event }), `cmd:login-browser:${sid}`) });
    return { ok: true };
  }
  throw new ApiError(400, "action must be input, confirm or cancel");
}

/** Closes every open window of a profile (used before re-opening one, and on delete). */
export async function closeBrowserLogins(user: SessionUser, profileId: string): Promise<{ closed: number }> {
  await ownedSavedProfile(user, profileId);
  const rows = await db
    .update(loginSessions)
    .set({ status: "cancelled", message: "Closed by the owner.", finishedAt: new Date(), frame: null })
    .where(and(eq(loginSessions.savedProfileId, profileId), eq(loginSessions.ownerId, user.id), eq(loginSessions.status, "awaiting-user")))
    .returning({ id: loginSessions.id });
  for (const r of rows) await db.insert(loginProfileCommands).values({ sid: r.id, savedProfileId: profileId, ownerId: user.id, type: "cancel" });
  return { closed: rows.length };
}

/** Housekeeping: expire old windows and stale commands (best effort, called from the UI poll). */
export async function expireBrowserLogins(): Promise<void> {
  const now = new Date();
  await db
    .update(loginSessions)
    .set({ status: "expired", message: "The sign-in window timed out.", finishedAt: now, frame: null })
    .where(and(eq(loginSessions.scope, "login-browser"), eq(loginSessions.status, "awaiting-user"), sql`${loginSessions.expiresAt} < ${now}`));
  await db.delete(loginProfileCommands).where(and(sql`${loginProfileCommands.createdAt} < now() - interval '2 hours'`));
  // Expired / invalidated stored sessions are marked so the UI never offers a dead login as working.
  await db
    .update(savedLoginSessions)
    .set({ invalidatedAt: now, invalidatedReason: "expired" })
    .where(and(isNull(savedLoginSessions.invalidatedAt), sql`${savedLoginSessions.expiresAt} < ${now}`));
}

export { columnsOf as savedProfileColumns };
