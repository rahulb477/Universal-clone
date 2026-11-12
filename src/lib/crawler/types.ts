export type RenderMode = "fast" | "js" | "full";

export interface CrawlOptions {
  maxDepth: number;
  maxPages: number;
  /** Per-file limit in bytes. */
  maxFileSize: number;
  /** Total archive limit in bytes. */
  maxTotalSize: number;
  delayMs: number;
  concurrency: number;
  renderMode: RenderMode;
  includeSubdomains: boolean;
  crawlQueryParams: boolean;
  useSitemap: boolean;
  downloadAssets: boolean;
  externalAssets: boolean;
  respectRobots: boolean;
  includePatterns: string[];
  excludePatterns: string[];
  /** Query parameters removed from every URL (tracking parameters). */
  stripParams: string[];
  /** Query parameters that make a URL be skipped entirely. */
  denyParams: string[];
  /** If non-empty, only these query parameters are kept (all others dropped). */
  allowParams: string[];
  maxQueryVariantsPerPath: number;
  maxQueryParams: number;
  restrictToPathPrefix: boolean;
  retries: number;
  retryBaseMs: number;
  requestTimeoutMs: number;
  maxDurationMs: number;
  visualCompare: boolean;
  visualMaxPages: number;
}

export const DEFAULT_STRIP_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "igshid",
  "yclid",
  "twclid",
];

export const DEFAULT_DENY_PARAMS = [
  "sessionid",
  "phpsessid",
  "jsessionid",
  "sid",
  "replytocom",
  "print",
  "share",
  "action",
];

const MB = 1024 * 1024;

export const DEFAULT_OPTIONS: CrawlOptions = {
  maxDepth: 5,
  maxPages: 200,
  maxFileSize: 25 * MB,
  maxTotalSize: 500 * MB,
  delayMs: 100,
  concurrency: 4,
  renderMode: "fast",
  includeSubdomains: false,
  crawlQueryParams: true,
  useSitemap: true,
  downloadAssets: true,
  externalAssets: true,
  respectRobots: true,
  includePatterns: [],
  excludePatterns: [],
  stripParams: DEFAULT_STRIP_PARAMS,
  denyParams: DEFAULT_DENY_PARAMS,
  allowParams: [],
  maxQueryVariantsPerPath: 30,
  maxQueryParams: 3,
  restrictToPathPrefix: false,
  retries: 3,
  retryBaseMs: 500,
  requestTimeoutMs: 20000,
  maxDurationMs: 30 * 60 * 1000,
  visualCompare: false,
  visualMaxPages: 3,
};

/** Hard ceilings. User supplied values are always clamped to these. */
export const HARD_LIMITS = {
  maxDepth: 20,
  maxPages: Number(process.env.CRAWLER_HARD_MAX_PAGES) || 5000,
  maxFileSize: 200 * MB,
  maxTotalSize: Number(process.env.CRAWLER_HARD_MAX_TOTAL_BYTES) || 2048 * MB,
  concurrency: 8,
  maxDurationMs: 2 * 60 * 60 * 1000,
  requestTimeoutMs: 60000,
  retries: 6,
  patterns: 50,
  visualMaxPages: 10,
};

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function bool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}
function strList(v: unknown, def: string[], max = 100): string[] {
  if (!Array.isArray(v)) return def;
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 200)
    .slice(0, max);
}

/** Validates and clamps untrusted option input. */
export function sanitizeOptions(input: unknown): CrawlOptions {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const d = DEFAULT_OPTIONS;
  const mode = i.renderMode === "js" || i.renderMode === "full" || i.renderMode === "fast" ? i.renderMode : d.renderMode;
  return {
    maxDepth: Math.floor(num(i.maxDepth, d.maxDepth, 0, HARD_LIMITS.maxDepth)),
    maxPages: Math.floor(num(i.maxPages, d.maxPages, 1, HARD_LIMITS.maxPages)),
    maxFileSize: Math.floor(num(i.maxFileSize, d.maxFileSize, 1024, HARD_LIMITS.maxFileSize)),
    maxTotalSize: Math.floor(num(i.maxTotalSize, d.maxTotalSize, 1024, HARD_LIMITS.maxTotalSize)),
    delayMs: Math.floor(num(i.delayMs, d.delayMs, 0, 30000)),
    concurrency: Math.floor(num(i.concurrency, d.concurrency, 1, HARD_LIMITS.concurrency)),
    renderMode: mode,
    includeSubdomains: bool(i.includeSubdomains, d.includeSubdomains),
    crawlQueryParams: bool(i.crawlQueryParams, d.crawlQueryParams),
    useSitemap: bool(i.useSitemap, d.useSitemap),
    downloadAssets: bool(i.downloadAssets, d.downloadAssets),
    externalAssets: bool(i.externalAssets, d.externalAssets),
    respectRobots: bool(i.respectRobots, d.respectRobots),
    includePatterns: strList(i.includePatterns, d.includePatterns, HARD_LIMITS.patterns),
    excludePatterns: strList(i.excludePatterns, d.excludePatterns, HARD_LIMITS.patterns),
    stripParams: strList(i.stripParams, d.stripParams).map((s) => s.toLowerCase()),
    denyParams: strList(i.denyParams, d.denyParams).map((s) => s.toLowerCase()),
    allowParams: strList(i.allowParams, d.allowParams).map((s) => s.toLowerCase()),
    maxQueryVariantsPerPath: Math.floor(num(i.maxQueryVariantsPerPath, d.maxQueryVariantsPerPath, 1, 500)),
    maxQueryParams: Math.floor(num(i.maxQueryParams, d.maxQueryParams, 1, 10)),
    restrictToPathPrefix: bool(i.restrictToPathPrefix, d.restrictToPathPrefix),
    retries: Math.floor(num(i.retries, d.retries, 0, HARD_LIMITS.retries)),
    retryBaseMs: Math.floor(num(i.retryBaseMs, d.retryBaseMs, 0, 10000)),
    requestTimeoutMs: Math.floor(num(i.requestTimeoutMs, d.requestTimeoutMs, 1000, HARD_LIMITS.requestTimeoutMs)),
    maxDurationMs: Math.floor(num(i.maxDurationMs, d.maxDurationMs, 1000, HARD_LIMITS.maxDurationMs)),
    visualCompare: bool(i.visualCompare, d.visualCompare),
    visualMaxPages: Math.floor(num(i.visualMaxPages, d.visualMaxPages, 1, HARD_LIMITS.visualMaxPages)),
  };
}

export type CrawlStatus = "idle" | "running" | "paused" | "completed" | "cancelled" | "failed" | "interrupted";

export interface CrawlStats {
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesRemaining: number;
  pagesFailed: number;
  pagesSkipped: number;
  assetsDiscovered: number;
  assetsDownloaded: number;
  assetsFailed: number;
  duplicateUrls: number;
  duplicateAssets: number;
  externalLinks: number;
  currentUrls: string[];
  bytesDownloaded: number;
  speedBps: number;
  maxDepthReached: number;
  /** completed / discovered pages. Both numbers are real; the discovered total can still grow. */
  progress: number;
  elapsedMs: number;
  status: CrawlStatus;
  stopReason?: string;
}

export type LogTag =
  | "INFO"
  | "FOUND"
  | "CRAWLING"
  | "ASSET"
  | "COMPLETE"
  | "SKIP"
  | "RETRY"
  | "FAILED"
  | "WARN"
  | "DUP";

export interface LogEvent {
  t: number;
  tag: LogTag;
  message: string;
}

export interface FailureRecord {
  url: string;
  kind: "page" | "asset";
  status?: number;
  error: string;
  referrer?: string;
  attempts?: number;
}

export interface CrawlResult {
  status: CrawlStatus;
  error?: string;
  zipPath?: string;
  reportDir?: string;
  stats: CrawlStats;
}
