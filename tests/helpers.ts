import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { Crawler } from "@/lib/crawler/engine";
import type { CrawlOptions, CrawlResult, LogEvent } from "@/lib/crawler/types";

// Chromium needs shared libraries that are not installed system-wide in this sandbox.
const LIBS = "/tmp/libs/root/usr/lib/x86_64-linux-gnu:/tmp/libs/root/lib/x86_64-linux-gnu";
if (fs.existsSync("/tmp/libs/root/usr/lib/x86_64-linux-gnu") && !process.env.LD_LIBRARY_PATH?.includes("/tmp/libs")) {
  process.env.LD_LIBRARY_PATH = LIBS + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");
}

export const FAST: Partial<CrawlOptions> = { delayMs: 0, retryBaseMs: 5, retries: 3, concurrency: 4, requestTimeoutMs: 5000, maxDepth: 6, maxPages: 300 };

export interface Run {
  result: CrawlResult;
  crawler: Crawler;
  logs: LogEvent[];
  workDir: string;
  /** Extracted ZIP contents. */
  out: string;
  zip?: AdmZip;
  report: Record<string, any>;
  files: string[];
}

export function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else out.push(r);
  }
  return out;
}

export async function runCrawl(url: string, options: Partial<CrawlOptions> = {}, onCrawler?: (c: Crawler) => void): Promise<Run> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-test-"));
  const crawler = new Crawler(url, { ...FAST, ...options }, { workDir, allowPrivateNetworks: true });
  const logs: LogEvent[] = [];
  crawler.on("log", (l: LogEvent) => logs.push(l));
  onCrawler?.(crawler);
  const result = await crawler.run();
  return finishRun({ result, crawler, logs, workDir });
}

export function finishRun(base: { result: CrawlResult; crawler: Crawler; logs: LogEvent[]; workDir: string }): Run {
  const out = path.join(base.workDir, "extracted");
  let zip: AdmZip | undefined;
  let report: Record<string, any> = {};
  if (base.result.zipPath && fs.existsSync(base.result.zipPath)) {
    zip = new AdmZip(base.result.zipPath);
    zip.extractAllTo(out, true);
    const rp = path.join(out, "_report", "crawl-report.json");
    if (fs.existsSync(rp)) report = JSON.parse(fs.readFileSync(rp, "utf8"));
  }
  return { ...base, out, zip, report, files: fs.existsSync(out) ? listFiles(out) : [] };
}

export function read(run: Run, rel: string): string {
  return fs.readFileSync(path.join(run.out, rel), "utf8");
}
export function has(run: Run, rel: string): boolean {
  return fs.existsSync(path.join(run.out, rel));
}

export function cleanup(run?: Run) {
  if (run) fs.rmSync(run.workDir, { recursive: true, force: true });
}
