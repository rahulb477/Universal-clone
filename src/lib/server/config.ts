import path from "node:path";
import { ApiError, ID_RE } from "./errors";

export const DATA_DIR = process.env.CRAWL_DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), ".crawl-data");

export function jobDir(id: string): string {
  if (!ID_RE.test(id)) throw new ApiError(400, "Invalid job id");
  return path.join(/* turbopackIgnore: true */ DATA_DIR, id);
}

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const limits = {
  get maxConcurrentJobs() {
    return num("CRAWLER_MAX_CONCURRENT_JOBS", 5);
  },
  get maxActiveJobsPerUser() {
    return num("CRAWLER_MAX_ACTIVE_JOBS_PER_USER", 5);
  },
  get storageQuotaBytes() {
    return num("CRAWLER_STORAGE_QUOTA_BYTES", 5 * 1024 * 1024 * 1024);
  },
  get retentionHours() {
    return num("CRAWL_RETENTION_HOURS", 24);
  },
  get startsPerMinute() {
    return num("CRAWLER_STARTS_PER_MINUTE", 5);
  },
  get sessionTtlHours() {
    return num("CRAWLER_SESSION_TTL_HOURS", 12);
  },
  get interactiveLoginMinutes() {
    return Math.min(60, num("CRAWLER_INTERACTIVE_LOGIN_MINUTES", 10));
  },
  /** How long one "Login with Browser" window may stay open. */
  get browserLoginMinutes() {
    return Math.min(60, num("CRAWLER_LOGIN_BROWSER_MINUTES", 15));
  },
  /** Lifetime of a saved login session before the user must sign in again. */
  get savedSessionTtlHours() {
    return num("CRAWLER_SAVED_SESSION_TTL_HOURS", 24 * 30);
  },
  get maxSavedProfiles() {
    return Math.min(200, num("CRAWLER_MAX_SAVED_PROFILES", 25));
  },
};

/**
 * Where crawls execute.
 *  - "inline":   this Node process also runs the worker loop (single server / local use / tests).
 *  - "external": a separate persistent worker process consumes the queue (Vercel + worker split).
 * Serverless platforms cannot host Chromium crawls, so the default there is "external".
 */
export function workerMode(): "inline" | "external" {
  const v = process.env.CRAWLER_WORKER_MODE;
  if (v === "inline" || v === "external") return v;
  return process.env.VERCEL ? "external" : "inline";
}

export const allowPrivateNetworks = () => process.env.CRAWLER_ALLOW_PRIVATE_NETWORKS === "1";
