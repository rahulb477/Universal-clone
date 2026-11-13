import { bigint, bigserial, boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Application accounts. Every job, profile and download belongs to exactly one user. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  disabled: boolean("disabled").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** id is the SHA-256 of the cookie token. */
export const userSessions = pgTable("user_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  userAgent: text("user_agent"),
});

/** One row per crawl job: the queue entry, the live state and the download history. */
export const crawlJobs = pgTable("crawl_jobs", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  status: text("status").notNull(),
  options: jsonb("options").notNull(),
  stats: jsonb("stats"),
  error: text("error"),
  stopReason: text("stop_reason"),
  hasZip: boolean("has_zip").notNull().default(false),
  zipBytes: bigint("zip_bytes", { mode: "number" }).notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  ownerId: text("owner_id"),
  /** public | authenticated | combined */
  mode: text("mode").notNull().default("public"),
  resume: boolean("resume").notNull().default(false),
  workerId: text("worker_id"),
  heartbeatAt: ts("heartbeat_at"),
  startedAt: ts("started_at"),
  storage: text("storage"),
  storageKey: text("storage_key"),
  zipSha256: text("zip_sha256"),
  zipEntries: integer("zip_entries"),
  downloadCount: integer("download_count").notNull().default(0),
  lastDownloadedAt: ts("last_downloaded_at"),
});

export const authProfiles = pgTable("auth_profiles", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  ownerId: text("owner_id").notNull(),
  position: integer("position").notNull(),
  name: text("name").notNull(),
  method: text("method").notNull(),
  loginOrigin: text("login_origin").notNull(),
  usernameHint: text("username_hint").notNull().default(""),
  status: text("status").notNull().default("waiting-for-credentials"),
  secret: text("secret"),
  sessionState: text("session_state"),
  sessionSavedAt: ts("session_saved_at"),
  sessionExpiresAt: ts("session_expires_at"),
  clearedAt: ts("cleared_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  /** The reusable "Login with Browser" profile this per-crawl login was copied from, if any. */
  savedProfileId: text("saved_profile_id"),
});

/**
 * A reusable "Login with Browser" profile: an owner-scoped, origin-locked browser session that can be
 * attached to later crawls. Holds metadata only — the session itself lives in savedLoginSessions,
 * encrypted with additional authenticated data binding it to this profile, its owner and its origin.
 */
export const targetLoginProfiles = pgTable("target_login_profiles", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  /** Host (plus non-default port) this profile may be used for. */
  targetHost: text("target_host").notNull(),
  targetOrigin: text("target_origin").notNull(),
  /** Allow subdomains of targetHost (app.example.com for example.com). */
  matchSubdomains: boolean("match_subdomains").notNull().default(false),
  startUrl: text("start_url").notNull(),
  loginUrl: text("login_url"),
  authenticatedSelector: text("authenticated_selector"),
  usernameHint: text("username_hint").notNull().default(""),
  /** active | needs-request-capture | session-expired | session-rejected | login-failed */
  status: text("status").notNull().default("active"),
  statusMessage: text("status_message"),
  lastUsedAt: ts("last_used_at"),
  useCount: integer("use_count").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Encrypted browser session of one reusable profile. Never leaves the server. */
export const savedLoginSessions = pgTable("saved_login_sessions", {
  profileId: text("profile_id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  state: text("state").notNull(),
  cookieCount: integer("cookie_count").notNull().default(0),
  originCount: integer("origin_count").notNull().default(0),
  capturedAt: ts("captured_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  lastValidatedAt: ts("last_validated_at"),
  invalidatedAt: ts("invalidated_at"),
  invalidatedReason: text("invalidated_reason"),
});

/** Web -> worker commands for reusable-profile sign-in windows (they exist outside any job's queue). */
export const loginProfileCommands = pgTable("login_profile_commands", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sid: text("sid").notNull(),
  savedProfileId: text("saved_profile_id").notNull(),
  ownerId: text("owner_id").notNull(),
  /** open | input | confirm | cancel */
  type: text("type").notNull(),
  payload: text("payload"),
  createdAt: ts("created_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
  result: text("result"),
});

export const loginSessions = pgTable("login_sessions", {
  id: text("id").primaryKey(),
  /** Null for a standalone "Login with Browser" session (see savedProfileId). */
  jobId: text("job_id"),
  profileId: text("profile_id"),
  ownerId: text("owner_id").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  message: text("message"),
  pageUrl: text("page_url"),
  pageTitle: text("page_title"),
  frame: text("frame"),
  frameSeq: integer("frame_seq").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  finishedAt: ts("finished_at"),
  /** Set when this window signs in a reusable profile instead of a crawl's own login. */
  savedProfileId: text("saved_profile_id"),
  /** "crawl" (a job's sign-in) or "login-browser" (standalone reusable-profile sign-in). */
  scope: text("scope").notNull().default("crawl"),
});

export const jobCommands = pgTable("job_commands", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  jobId: text("job_id").notNull(),
  type: text("type").notNull(),
  payload: text("payload"),
  createdAt: ts("created_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
  result: text("result"),
});

export const jobEvents = pgTable("job_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  jobId: text("job_id").notNull(),
  type: text("type").notNull(),
  data: jsonb("data").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  startedAt: ts("started_at").notNull().defaultNow(),
  heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
  info: jsonb("info").notNull(),
});

export const rateEvents = pgTable("rate_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  bucket: text("bucket").notNull(),
  at: ts("at").notNull().defaultNow(),
});

/** Marker row (id = 'first-admin'): first-administrator setup has been completed and stays disabled. */
export const adminSetup = pgTable("admin_setup", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  completedAt: ts("completed_at").notNull().defaultNow(),
});

export type CrawlJobRow = typeof crawlJobs.$inferSelect;
export type AuthProfileRow = typeof authProfiles.$inferSelect;
export type LoginSessionRow = typeof loginSessions.$inferSelect;
export type TargetLoginProfileRow = typeof targetLoginProfiles.$inferSelect;
export type SavedLoginSessionRow = typeof savedLoginSessions.$inferSelect;
export type UserRow = typeof users.$inferSelect;
