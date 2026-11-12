import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { crawlJobs, type CrawlJobRow } from "@/db/schema";
import { Crawler } from "./engine";
import { assertPublicUrl, SsrfError } from "./security";
import { sanitizeOptions, type CrawlStats, type LogEvent } from "./types";

export const DATA_DIR = process.env.CRAWL_DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), ".crawl-data");
const MAX_CONCURRENT_JOBS = Number(process.env.CRAWLER_MAX_CONCURRENT_JOBS) || 2;
const STORAGE_QUOTA = Number(process.env.CRAWLER_STORAGE_QUOTA_BYTES) || 5 * 1024 * 1024 * 1024;
const RETENTION_HOURS = Number(process.env.CRAWL_RETENTION_HOURS) || 24;
const STARTS_PER_MINUTE = Number(process.env.CRAWLER_STARTS_PER_MINUTE) || 5;
const LOG_BUFFER = 500;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type JobEvent = { type: "log" | "stats" | "status" | "done"; data: unknown };

interface LiveJob {
  id: string;
  crawler: Crawler;
  logs: LogEvent[];
  subs: Set<(e: JobEvent) => void>;
  lastDb: number;
}

export const ID_RE = /^[a-f0-9]{16}$/;

export function jobDir(id: string): string {
  if (!ID_RE.test(id)) throw new ApiError(400, "Invalid job id");
  return path.join(/* turbopackIgnore: true */ DATA_DIR, id);
}

class JobManager {
  live = new Map<string, LiveJob>();
  private starts = new Map<string, number[]>();
  private ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init() {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    try {
      // Jobs that were running when the server stopped can be resumed from their saved state.
      await db.update(crawlJobs).set({ status: "interrupted" }).where(inArray(crawlJobs.status, ["running", "paused"]));
      await this.cleanupOld();
    } catch (e) {
      console.error("[crawler] init failed:", (e as Error).message);
    }
  }

  /** Retention: delete finished jobs (files + row) older than CRAWL_RETENTION_HOURS. */
  async cleanupOld() {
    const cutoff = new Date(Date.now() - RETENTION_HOURS * 3600 * 1000);
    const old = await db.select({ id: crawlJobs.id }).from(crawlJobs).where(lt(crawlJobs.createdAt, cutoff));
    for (const o of old) {
      if (this.live.has(o.id)) continue;
      await fs.promises.rm(jobDir(o.id), { recursive: true, force: true });
      await db.delete(crawlJobs).where(eq(crawlJobs.id, o.id));
    }
  }

  private rateLimit(ip: string) {
    const now = Date.now();
    const recent = (this.starts.get(ip) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= STARTS_PER_MINUTE) throw new ApiError(429, `Too many crawls started. Limit: ${STARTS_PER_MINUTE} per minute.`);
    recent.push(now);
    this.starts.set(ip, recent);
  }

  private runningCount() {
    let n = 0;
    for (const j of this.live.values()) if (j.crawler.status === "running" || j.crawler.status === "paused") n++;
    return n;
  }

  async start(rawUrl: unknown, options: unknown, ip: string): Promise<string> {
    await this.ready;
    if (typeof rawUrl !== "string" || !rawUrl.trim() || rawUrl.length > 2048) throw new ApiError(400, "Please enter a website URL.");
    this.rateLimit(ip);
    if (this.runningCount() >= MAX_CONCURRENT_JOBS) throw new ApiError(429, `The server is already running ${MAX_CONCURRENT_JOBS} crawls. Wait for one to finish.`);
    const used = await db.select({ total: sql<number>`coalesce(sum(${crawlJobs.zipBytes}), 0)::float8` }).from(crawlJobs);
    if ((used[0]?.total ?? 0) >= STORAGE_QUOTA) throw new ApiError(507, "Server storage quota reached. Delete old downloads first.");

    let url = rawUrl.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    const allowPrivate = process.env.CRAWLER_ALLOW_PRIVATE_NETWORKS === "1";
    try {
      await assertPublicUrl(url, allowPrivate);
    } catch (e) {
      if (e instanceof SsrfError) throw new ApiError(400, `This address is not allowed: ${e.message}`);
      throw e;
    }
    const opts = sanitizeOptions(options);
    const id = crypto.randomBytes(8).toString("hex");
    await db.insert(crawlJobs).values({ id, url, status: "running", options: opts });
    const crawler = new Crawler(url, opts, { workDir: jobDir(id), allowPrivateNetworks: allowPrivate });
    this.attach(id, crawler);
    return id;
  }

  async resume(id: string): Promise<void> {
    await this.ready;
    const live = this.live.get(id);
    if (live) {
      live.crawler.resumeCrawl();
      return;
    }
    const row = await this.getRow(id);
    if (!row) throw new ApiError(404, "Job not found");
    if (row.status !== "interrupted") throw new ApiError(409, "Only paused or interrupted crawls can be resumed.");
    if (!fs.existsSync(path.join(jobDir(id), "state.json"))) throw new ApiError(409, "No saved state is available for this crawl.");
    if (this.runningCount() >= MAX_CONCURRENT_JOBS) throw new ApiError(429, "Too many crawls are running.");
    await db.update(crawlJobs).set({ status: "running", error: null }).where(eq(crawlJobs.id, id));
    const crawler = new Crawler(row.url, sanitizeOptions(row.options), {
      workDir: jobDir(id),
      resume: true,
      allowPrivateNetworks: process.env.CRAWLER_ALLOW_PRIVATE_NETWORKS === "1",
    });
    this.attach(id, crawler);
  }

  private attach(id: string, crawler: Crawler) {
    const job: LiveJob = { id, crawler, logs: [], subs: new Set(), lastDb: 0 };
    this.live.set(id, job);
    const fan = (e: JobEvent) => job.subs.forEach((s) => s(e));
    crawler.on("log", (l: LogEvent) => {
      job.logs.push(l);
      if (job.logs.length > LOG_BUFFER) job.logs.splice(0, job.logs.length - LOG_BUFFER);
      fan({ type: "log", data: l });
    });
    crawler.on("stats", (s: CrawlStats) => {
      fan({ type: "stats", data: s });
      if (Date.now() - job.lastDb > 2000) {
        job.lastDb = Date.now();
        void db.update(crawlJobs).set({ stats: s, status: s.status === "completed" ? "running" : s.status }).where(eq(crawlJobs.id, id)).catch(() => {});
      }
    });
    crawler.on("status", (s: string) => fan({ type: "status", data: s }));
    void crawler
      .run()
      .then(async (result) => {
        let zipBytes = 0;
        if (result.zipPath) zipBytes = (await fs.promises.stat(result.zipPath).catch(() => null))?.size ?? 0;
        await db
          .update(crawlJobs)
          .set({
            status: result.status,
            stats: result.stats,
            error: result.error ?? null,
            stopReason: result.stats.stopReason ?? null,
            hasZip: !!result.zipPath,
            zipBytes,
            finishedAt: new Date(),
          })
          .where(eq(crawlJobs.id, id));
        fan({ type: "done", data: { status: result.status, error: result.error, zipBytes } });
      })
      .catch(async (e: Error) => {
        await db.update(crawlJobs).set({ status: "failed", error: e.message, finishedAt: new Date() }).where(eq(crawlJobs.id, id));
        fan({ type: "done", data: { status: "failed", error: e.message } });
      })
      .finally(() => setTimeout(() => this.live.delete(id), 60000).unref?.());
  }

  control(id: string, action: string) {
    const live = this.live.get(id);
    if (!live || (live.crawler.status !== "running" && live.crawler.status !== "paused")) throw new ApiError(409, "This crawl is not running.");
    if (action === "pause") live.crawler.pause();
    else if (action === "cancel") live.crawler.cancel();
    else throw new ApiError(400, "Unknown action");
  }

  async getRow(id: string): Promise<CrawlJobRow | undefined> {
    const rows = await db.select().from(crawlJobs).where(eq(crawlJobs.id, jobDir(id) && id));
    return rows[0];
  }

  async get(id: string) {
    await this.ready;
    const row = await this.getRow(id);
    if (!row) return null;
    const live = this.live.get(id);
    return { job: live ? { ...row, status: live.crawler.status, stats: live.crawler.getStats() } : row, logs: live?.logs.slice(-200) ?? [], live: !!live };
  }

  async list(): Promise<CrawlJobRow[]> {
    await this.ready;
    const rows = await db.select().from(crawlJobs).orderBy(desc(crawlJobs.createdAt)).limit(30);
    return rows.map((r) => {
      const l = this.live.get(r.id);
      return l ? { ...r, status: l.crawler.status, stats: l.crawler.getStats() } : r;
    });
  }

  subscribe(id: string, fn: (e: JobEvent) => void): (() => void) | null {
    const live = this.live.get(id);
    if (!live) return null;
    live.subs.add(fn);
    return () => live.subs.delete(fn);
  }

  async remove(id: string) {
    const live = this.live.get(id);
    if (live && (live.crawler.status === "running" || live.crawler.status === "paused")) {
      live.crawler.cancel();
      throw new ApiError(409, "The crawl was still running and is being cancelled. Try deleting again in a moment.");
    }
    this.live.delete(id);
    await fs.promises.rm(jobDir(id), { recursive: true, force: true });
    await db.delete(crawlJobs).where(eq(crawlJobs.id, id));
  }
}

const g = globalThis as typeof globalThis & { __crawlManager?: JobManager };
export function getManager(): JobManager {
  if (!g.__crawlManager) g.__crawlManager = new JobManager();
  return g.__crawlManager;
}
