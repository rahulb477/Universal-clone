import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ApiError } from "./errors";
import { clientIp, hashPassword, normalizeEmail, rateLimit } from "./users";

/**
 * One-time first-administrator setup.
 *
 * The operator sets ADMIN_SETUP_KEY in the hosting platform's environment (Vercel → Settings →
 * Environment Variables) and visits /setup-admin. The key never reaches a browser: this module is
 * imported only by server routes, the value is never rendered, returned or logged.
 *
 * Rules enforced here and in the API route (never in the page alone):
 *  - ADMIN_SETUP_KEY must be present and at least 32 characters; otherwise setup is disabled.
 *  - The supplied key is compared in constant time against the configured one.
 *  - Setup is disabled once an administrator exists, and permanently disabled once a first admin
 *    was created through this endpoint (`admin_setup` marker row, which survives deletion of the
 *    account).
 *  - Creation happens inside one PostgreSQL transaction holding an advisory lock, so two parallel
 *    requests cannot both create an administrator.
 */

export const ADMIN_SETUP_LOCK = 727274002;
const MIN_KEY_LENGTH = 32;
const MARKER_ID = "first-admin";

export type SetupState = "available" | "completed" | "not-configured" | "key-too-weak";

export interface SetupKeyInfo {
  /** The configured key, or null when it is missing / too weak to be used. */
  key: string | null;
  state: "configured" | "not-configured" | "key-too-weak";
}

/** Placeholders that must never be accepted as a production secret. */
const WEAK_KEY_PATTERNS = ["changeme", "change-me", "your-key", "yourkey", "placeholder", "example", "password", "secret-key"];

function distinctChars(s: string): number {
  return new Set(s).size;
}

/**
 * Reads ADMIN_SETUP_KEY. A missing key, a key shorter than 32 characters, a key made of fewer than
 * 12 distinct characters ("aaaa…") or an obvious placeholder counts as not configured: setup stays
 * disabled instead of running with a guessable secret.
 */
export function setupKeyInfo(): SetupKeyInfo {
  const raw = process.env.ADMIN_SETUP_KEY;
  if (typeof raw !== "string" || raw.trim() === "") return { key: null, state: "not-configured" };
  const key = raw.trim();
  if (key.length < MIN_KEY_LENGTH) return { key: null, state: "key-too-weak" };
  if (distinctChars(key) < 12) return { key: null, state: "key-too-weak" };
  const lower = key.toLowerCase();
  if (WEAK_KEY_PATTERNS.some((p) => lower.includes(p))) return { key: null, state: "key-too-weak" };
  return { key, state: "configured" };
}

/**
 * Constant-time comparison of the submitted key with the configured one.
 * Both sides are hashed first, so the comparison does not leak the configured key's length or
 * prefix through timing either.
 */
export function setupKeyMatches(candidate: unknown): boolean {
  const { key } = setupKeyInfo();
  if (!key || typeof candidate !== "string" || candidate.length === 0 || candidate.length > 512) return false;
  const a = crypto.createHash("sha256").update(candidate, "utf8").digest();
  const b = crypto.createHash("sha256").update(key, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/** Same shape check the rest of the app uses, with a setup-specific message. */
export function assertSetupEmail(raw: unknown): string {
  try {
    return normalizeEmail(raw);
  } catch {
    throw new ApiError(400, "Enter a valid email address.");
  }
}

const CLASSES: Array<{ re: RegExp; label: string }> = [
  { re: /[a-z]/, label: "a lowercase letter" },
  { re: /[A-Z]/, label: "an uppercase letter" },
  { re: /[0-9]/, label: "a digit" },
  { re: /[^A-Za-z0-9]/, label: "a symbol" },
];

export interface PasswordPolicyResult {
  ok: boolean;
  /** Human-readable list of what is missing (empty when ok). */
  problems: string[];
}

/** Pure policy check, shared by the API and the page's inline hints. */
export function checkStrongPassword(password: unknown, email?: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (typeof password !== "string" || password.length === 0) return { ok: false, problems: ["Enter a password."] };
  if (password.length < 12) problems.push("at least 12 characters");
  if (password.length > 200) problems.push("at most 200 characters");
  const matched = CLASSES.filter((c) => c.re.test(password)).length;
  if (matched < 3) problems.push(`at least three of: ${CLASSES.map((c) => c.label).join(", ")}`);
  const lowerPw = password.toLowerCase();
  if (email) {
    const local = email.split("@")[0]?.toLowerCase() ?? "";
    if (local.length >= 3 && lowerPw.includes(local)) problems.push("must not contain your email address");
  }
  return { ok: problems.length === 0, problems };
}

export function assertStrongPassword(password: unknown, email?: string): string {
  const r = checkStrongPassword(password, email);
  if (!r.ok) throw new ApiError(400, `Choose a stronger password: ${r.problems.join(", ")}.`);
  return password as string;
}

/** One round trip: does the marker table exist, and does it already hold the completion row? */
async function markerPresent(): Promise<boolean> {
  const res = await db.execute(sql.raw(`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'admin_setup' AND c.relkind = 'r'
    ) AS has_table`));
  if (!(res.rows[0] as { has_table: boolean } | undefined)?.has_table) return false;
  const marker = await db.execute(sql`SELECT 1 AS done FROM admin_setup WHERE id = ${MARKER_ID} LIMIT 1`);
  return marker.rows.length > 0;
}

/**
 * Current state of first-admin setup.
 * `completed` is reported when a marker row exists or when any row in `users` has role 'admin'
 * (e.g. an account created earlier with `npm run user:create`).
 */
export async function setupState(): Promise<SetupState> {
  const key = setupKeyInfo();
  if (!key.key) return key.state === "key-too-weak" ? "key-too-weak" : "not-configured";
  const admins = await db.execute(sql`SELECT 1 AS found FROM users WHERE role = 'admin' LIMIT 1`);
  if (admins.rows.length > 0) return "completed";
  if (await markerPresent()) return "completed";
  return "available";
}

export interface SetupStatus {
  setupAvailable: boolean;
  state: SetupState;
  /** Short, safe explanation; never contains the key or any part of it. */
  message: string;
}

const MESSAGES: Record<SetupState, string> = {
  available: "First administrator setup is available.",
  completed: "First administrator setup is already complete. Sign in with your administrator account.",
  "not-configured": "Setup is disabled: ADMIN_SETUP_KEY is not configured on the server.",
  "key-too-weak": "Setup is disabled: ADMIN_SETUP_KEY must be a random secret of at least 32 characters.",
};

export function describeState(state: SetupState): SetupStatus {
  return { setupAvailable: state === "available", state, message: MESSAGES[state] };
}

/** Status for the page. A database that is unreachable is reported as unavailable, never as available. */
export async function publicSetupStatus(): Promise<SetupStatus> {
  try {
    return describeState(await setupState());
  } catch (e) {
    console.error("[setup] could not read setup state:", (e as Error).message);
    return { setupAvailable: false, state: "not-configured", message: "Setup is temporarily unavailable." };
  }
}

export interface SetupResult {
  user: { id: string; email: string; role: string };
}

/**
 * Creates the first administrator.
 *
 * Everything happens in one transaction that takes a PostgreSQL advisory lock first, so concurrent
 * submissions are serialised: the second one sees the marker / the administrator and answers 409.
 * The password is hashed with the application's existing scrypt scheme before the lock is taken,
 * to keep the lock hold time short.
 */
export async function createFirstAdmin(req: Request, body: { email?: unknown; password?: unknown; confirmPassword?: unknown; setupKey?: unknown }): Promise<SetupResult> {
  const { key } = setupKeyInfo();
  if (!key) throw new ApiError(503, "First administrator setup is disabled on this deployment.");

  // Same-origin + JSON-only is enforced by the route; rate limits are per client and global.
  await rateLimit(`setup:${clientIp(req)}`, 5, 900, "Too many setup attempts. Try again in 15 minutes.");
  // A second, generous global ceiling keeps a distributed flood from reaching the database/scrypt.
  await rateLimit("setup:all", 100, 900, "Too many setup attempts. Try again later.");

  if (!setupKeyMatches(body.setupKey)) throw new ApiError(403, "The setup key is not correct.");

  const email = assertSetupEmail(body.email);
  const password = assertStrongPassword(body.password, email);
  if (typeof body.confirmPassword !== "string" || body.confirmPassword !== password) {
    throw new ApiError(400, "The password confirmation does not match.");
  }

  const id = crypto.randomBytes(12).toString("hex");
  const passwordHash = await hashPassword(password);

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${ADMIN_SETUP_LOCK})`));
    // Normally created by drizzle/0002_admin_setup.sql. Re-created idempotently so a deployment
    // whose migrations have not been applied yet can still complete the first-admin setup.
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS admin_setup (
        id text PRIMARY KEY,
        user_id text REFERENCES users(id) ON DELETE SET NULL,
        completed_at timestamptz NOT NULL DEFAULT now()
      )`);

    const marker = await tx.execute(sql`SELECT 1 AS done FROM admin_setup WHERE id = ${MARKER_ID} LIMIT 1`);
    if (marker.rows.length > 0) return { status: "exists" as const };

    const admins = await tx.execute(sql`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
    if (admins.rows.length > 0) {
      // An administrator created earlier (CLI / another deploy) completes setup permanently.
      await tx.execute(sql`INSERT INTO admin_setup (id, user_id) SELECT ${MARKER_ID}, id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1 ON CONFLICT (id) DO NOTHING`);
      return { status: "exists" as const };
    }

    try {
      await tx.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${id}, ${email}, ${passwordHash}, ${"admin"})`);
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") throw new ApiError(409, "An account with this email address already exists. Sign in with it, or use another address.");
      throw e;
    }
    await tx.execute(sql`INSERT INTO admin_setup (id, user_id) VALUES (${MARKER_ID}, ${id}) ON CONFLICT (id) DO NOTHING`);
    return { status: "created" as const };
  });

  if (outcome.status !== "created") {
    throw new ApiError(409, "First administrator setup has already been completed. Sign in instead.");
  }
  return { user: { id, email, role: "admin" } };
}
