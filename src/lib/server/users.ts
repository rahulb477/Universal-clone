import crypto from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateEvents, userSessions, users } from "@/db/schema";
import { ApiError } from "./errors";

/**
 * Application-level authentication.
 *
 * - Passwords: scrypt (N=2^15, r=8, p=1), per-user random salt.
 * - Sessions: 256-bit random token in an HttpOnly, SameSite=Lax cookie; only its SHA-256 is stored.
 * - CSRF: every state-changing request must carry `x-csrf-token` = HMAC(session token), which a page
 *   can only obtain through a same-origin read of /api/auth/me, and must not come from another origin.
 * - Identity always comes from the session. No route accepts a user id or owner id from the client.
 */

export interface SessionUser {
  id: string;
  email: string;
  role: string;
}
export interface AuthContext {
  user: SessionUser;
  sessionId: string;
  csrfToken: string;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const SESSION_HOURS = () => Math.min(24 * 90, Math.max(1, Number(process.env.AUTH_SESSION_TTL_HOURS) || 24 * 7));
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function cookieName(): string {
  return cookieSecure() ? "__Host-uc_session" : "uc_session";
}

/** Secure cookies are the default in production; plain-HTTP deployments (local, tests) must opt out explicitly. */
export function cookieSecure(): boolean {
  if (process.env.AUTH_COOKIE_SECURE === "0") return false;
  if (process.env.AUTH_COOKIE_SECURE === "1") return true;
  return process.env.NODE_ENV === "production";
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password.normalize("NFKC"), salt, 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  const key = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password.normalize("NFKC"), salt, expected.length, { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), maxmem: SCRYPT.maxmem }, (e, k) => (e ? reject(e) : resolve(k))),
  );
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const csrfFor = (token: string) => crypto.createHmac("sha256", token).update("uc-csrf-v1").digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new ApiError(400, "Enter a valid email address.");
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new ApiError(400, "Enter a valid email address.");
  return email;
}

export function assertPassword(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 10 || raw.length > 200) throw new ApiError(400, "The password must have between 10 and 200 characters.");
  return raw;
}

/**
 * Sliding-window limiter backed by PostgreSQL, so it holds across stateless web instances.
 * Throws 429 when `limit` events already happened in the window.
 */
export async function rateLimit(bucket: string, limit: number, windowSeconds: number, message = "Too many requests. Try again later."): Promise<void> {
  const res = await db.execute(sql`
    WITH ins AS (INSERT INTO rate_events (bucket) VALUES (${bucket}) RETURNING 1)
    SELECT count(*)::int AS n FROM rate_events WHERE bucket = ${bucket} AND at > now() - make_interval(secs => ${windowSeconds})`);
  const n = Number((res.rows[0] as { n: number }).n);
  if (Math.random() < 0.02) void db.delete(rateEvents).where(lt(rateEvents.at, new Date(Date.now() - 24 * 3600 * 1000))).catch(() => {});
  if (n >= limit) throw new ApiError(429, message, { "retry-after": String(windowSeconds) });
}

/**
 * Client address for rate limiting. X-Forwarded-For is attacker-controlled unless a reverse proxy
 * that the operator runs overwrites it, so it is only read when TRUSTED_PROXY_HOPS says how many
 * trusted proxies sit in front of the app (Vercel: 1). Otherwise all clients share one bucket.
 */
export function clientIp(req: Request): string {
  const hops = Math.max(0, Math.floor(Number(process.env.TRUSTED_PROXY_HOPS) || 0));
  if (!hops) return "direct";
  const list = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list[list.length - hops] ?? "unknown";
}

export type RegistrationMode = "open" | "invite" | "closed";
export function registrationMode(): RegistrationMode {
  const v = process.env.AUTH_REGISTRATION;
  if (v === "open") return "open";
  if (v === "invite" && (process.env.AUTH_INVITE_CODE ?? "").length >= 16) return "invite";
  return "closed";
}

export async function createUser(emailRaw: unknown, passwordRaw: unknown, role = "user"): Promise<SessionUser> {
  const email = normalizeEmail(emailRaw);
  const password = assertPassword(passwordRaw);
  const id = crypto.randomBytes(12).toString("hex");
  const passwordHash = await hashPassword(password);
  try {
    await db.insert(users).values({ id, email, passwordHash, role });
  } catch (e) {
    if ((e as { code?: string; cause?: { code?: string } }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") {
      throw new ApiError(409, "An account with this email address already exists.");
    }
    throw e;
  }
  return { id, email, role };
}

export async function register(req: Request, body: { email?: unknown; password?: unknown; inviteCode?: unknown }): Promise<SessionUser> {
  const mode = registrationMode();
  if (mode === "closed") throw new ApiError(403, "Registration is closed. Ask the operator for an account.");
  await rateLimit(`register:${clientIp(req)}`, 10, 3600, "Too many registration attempts.");
  if (mode === "invite") {
    const code = typeof body.inviteCode === "string" ? body.inviteCode : "";
    if (!safeEqual(sha256(code), sha256(process.env.AUTH_INVITE_CODE!))) throw new ApiError(403, "The invite code is not valid.");
  }
  return createUser(body.email, body.password);
}

// A fixed dummy hash keeps the response time the same for unknown accounts.
let dummyHash: Promise<string> | null = null;

export async function login(req: Request, body: { email?: unknown; password?: unknown }): Promise<{ user: SessionUser; cookie: string; csrfToken: string }> {
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password.slice(0, 200) : "";
  await rateLimit(`login:${email}`, 10, 900, "Too many sign-in attempts for this account. Try again in 15 minutes.");
  await rateLimit(`login-ip:${clientIp(req)}`, 100, 900, "Too many sign-in attempts. Try again later.");
  const row = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  const ok = await verifyPassword(password, row?.passwordHash ?? (await dummyHash));
  if (!row || !ok || row.disabled) throw new ApiError(401, "Email or password is incorrect.");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS() * 3600 * 1000);
  await db.insert(userSessions).values({ id: sha256(token), userId: row.id, expiresAt, userAgent: (req.headers.get("user-agent") ?? "").slice(0, 300) });
  if (Math.random() < 0.05) void db.delete(userSessions).where(lt(userSessions.expiresAt, new Date())).catch(() => {});
  return { user: { id: row.id, email: row.email, role: row.role }, cookie: sessionCookie(token, expiresAt), csrfToken: csrfFor(token) };
}

function sessionCookie(token: string, expires: Date | null): string {
  // Inside a permitted <iframe> (APP_EMBED_ORIGINS) the browser treats the app as third-party: only a
  // SameSite=None, partitioned cookie is stored there. CSRF protection does not depend on SameSite.
  const embedded = cookieSecure() && /\S/.test(process.env.APP_EMBED_ORIGINS ?? "");
  const parts = [`${cookieName()}=${token}`, "Path=/", "HttpOnly", embedded ? "SameSite=None" : "SameSite=Lax"];
  if (cookieSecure()) parts.push("Secure");
  if (embedded) parts.push("Partitioned");
  parts.push(expires ? `Expires=${expires.toUTCString()}` : "Max-Age=0");
  return parts.join("; ");
}

export const clearedCookie = () => sessionCookie("", null);

function readToken(req: Request): string | null {
  const raw = req.headers.get("cookie") ?? "";
  const name = cookieName();
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
    }
  }
  return null;
}

/** Rejects requests that a browser marks as coming from another site, and foreign Origin headers. */
export function assertSameOrigin(req: Request): void {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new ApiError(403, "Cross-site requests are not allowed.");
  const origin = req.headers.get("origin");
  if (!origin) return;
  const configured = (process.env.APP_ORIGIN ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  if (configured.length) {
    if (!configured.includes(origin)) throw new ApiError(403, "Cross-site requests are not allowed.");
    return;
  }
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    throw new ApiError(403, "Cross-site requests are not allowed.");
  }
  if (host !== req.headers.get("host")) throw new ApiError(403, "Cross-site requests are not allowed.");
}

/** The signed-in user, or null. Never throws for a missing / invalid session. */
export async function currentUser(req: Request): Promise<AuthContext | null> {
  const token = readToken(req);
  if (!token) return null;
  const sid = sha256(token);
  const rows = await db
    .select({ id: users.id, email: users.email, role: users.role, disabled: users.disabled, lastSeenAt: userSessions.lastSeenAt })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.id, sid), gt(userSessions.expiresAt, new Date())))
    .limit(1);
  const r = rows[0];
  if (!r || r.disabled) return null;
  if (Date.now() - r.lastSeenAt.getTime() > 5 * 60 * 1000) void db.update(userSessions).set({ lastSeenAt: new Date() }).where(eq(userSessions.id, sid)).catch(() => {});
  return { user: { id: r.id, email: r.email, role: r.role }, sessionId: sid, csrfToken: csrfFor(token) };
}

/**
 * Every protected route starts here. Non-GET requests additionally need a same-origin request and
 * the session's CSRF token.
 */
export async function requireUser(req: Request): Promise<AuthContext> {
  const ctx = await currentUser(req);
  if (!ctx) throw new ApiError(401, "Sign in to continue.");
  if (req.method !== "GET" && req.method !== "HEAD") {
    assertSameOrigin(req);
    const supplied = req.headers.get("x-csrf-token") ?? "";
    if (!supplied || !safeEqual(supplied, ctx.csrfToken)) throw new ApiError(403, "Missing or invalid CSRF token.");
  }
  return ctx;
}

export async function logout(ctx: AuthContext): Promise<void> {
  await db.delete(userSessions).where(eq(userSessions.id, ctx.sessionId));
}

export async function logoutEverywhere(userId: string): Promise<void> {
  await db.delete(userSessions).where(eq(userSessions.userId, userId));
}
