import { bigint, boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** One row per crawl job (the download history). Files live on disk under CRAWL_DATA_DIR/<id>. */
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export type CrawlJobRow = typeof crawlJobs.$inferSelect;
