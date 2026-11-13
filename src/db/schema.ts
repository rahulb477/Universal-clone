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
});

export const loginSessions = pgTable("login_sessions", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  profileId: text("profile_id").notNull(),
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
export type UserRow = typeof users.$inferSelect;
