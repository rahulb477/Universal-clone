import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startExternal, startFixture, type Fixture } from "../fixtures/site";
import "../helpers"; // sets LD_LIBRARY_PATH for Chromium

/**
 * Boots the real production server (`next start`, requires a prior `npm run build`)
 * and drives it over HTTP + Server-Sent Events.
 */
async function boot(port: number, env: Record<string, string>): Promise<{ proc: ChildProcess; base: string }> {
  const proc = spawn(path.join(process.cwd(), "node_modules/.bin/next"), ["start", "-p", String(port)], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) return { proc, base };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error("server did not start (run `npm run build` first)");
}

async function readSse(url: string, until: (type: string) => boolean, timeoutMs = 90000) {
  const events: Array<{ type: string; data: any }> = [];
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = /event: (.*)/.exec(block)?.[1];
      const data = /data: (.*)/.exec(block)?.[1];
      if (type && data) {
        events.push({ type, data: JSON.parse(data) });
        if (until(type)) {
          await reader.cancel();
          return events;
        }
      }
    }
  }
  return events;
}

let fx: Fixture;
let ext: Awaited<ReturnType<typeof startExternal>>;
let open: { proc: ChildProcess; base: string };
let strict: { proc: ChildProcess; base: string };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-api-"));
const post = (base: string, body: unknown) => fetch(base + "/api/crawl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  ext = await startExternal();
  fx = await startFixture(ext.url);
  // `open` is the operator-configured instance allowed to reach private addresses (needed to crawl the local fixture).
  open = await boot(4311, { CRAWLER_ALLOW_PRIVATE_NETWORKS: "1", CRAWL_DATA_DIR: dataDir, CRAWLER_STARTS_PER_MINUTE: "100" });
  strict = await boot(4312, { CRAWL_DATA_DIR: dataDir, CRAWLER_STARTS_PER_MINUTE: "100" });
});
afterAll(async () => {
  open?.proc.kill();
  strict?.proc.kill();
  await fx?.close();
  await ext?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("HTTP API on the production server", () => {
  it("serves the dashboard", async () => {
    const html = await (await fetch(open.base + "/")).text();
    expect(html).toContain("Website Downloader");
    expect(html).toContain("Advanced settings");
  });

  it("requires the permission confirmation and a URL", async () => {
    expect((await post(open.base, { url: fx.url })).status).toBe(400);
    expect((await post(open.base, { confirmPermission: true })).status).toBe(400);
    const bad = await fetch(open.base + "/api/crawl", { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
  });

  it("16. the default (strict) server rejects private / metadata / non-http targets", async () => {
    for (const url of [fx.url, "http://localhost:3000", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "file:///etc/passwd", "http://10.0.0.1"]) {
      const r = await post(strict.base, { url, confirmPermission: true });
      expect(r.status, url).toBe(400);
      expect((await r.json()).error).toMatch(/not allowed/);
    }
  });

  it("rejects malformed job ids (no path traversal through the API)", async () => {
    for (const id of ["..", "../etc", "ZZZ", "0123456789abcdeg"]) {
      const r = await fetch(`${open.base}/api/crawl/${encodeURIComponent(id)}`);
      expect([400, 404]).toContain(r.status);
    }
    const r = await fetch(`${open.base}/api/crawl/0123456789abcdef/report/..%2f..%2fetc%2fpasswd`);
    expect(r.status).toBe(404);
  });

  it("runs a full crawl with live SSE progress, then serves ZIP, report and history", async () => {
    const r = await post(open.base, { url: fx.url + "/", confirmPermission: true, options: { maxPages: 25, delayMs: 0, retryBaseMs: 5, maxQueryVariantsPerPath: 3 } });
    expect(r.status).toBe(201);
    const { id } = await r.json();
    expect(id).toMatch(/^[a-f0-9]{16}$/);

    const events = await readSse(`${open.base}/api/crawl/${id}/events`, (t) => t === "done");
    const types = new Set(events.map((e) => e.type));
    expect(types.has("snapshot")).toBe(true);
    expect(types.has("log")).toBe(true);
    expect(types.has("stats")).toBe(true);
    expect(events.at(-1)!.type).toBe("done");
    const tags = new Set(events.filter((e) => e.type === "log").map((e) => e.data.tag));
    for (const t of ["FOUND", "CRAWLING", "ASSET", "COMPLETE"]) expect(tags.has(t), t).toBe(true);
    const stats = events.filter((e) => e.type === "stats").map((e) => e.data);
    // progress numbers are real and monotonic
    const crawled = stats.map((s) => s.pagesCrawled);
    expect([...crawled].sort((a, b) => a - b)).toEqual(crawled);
    expect(events.at(-1)!.data.status).toBe("completed");

    const job = await (await fetch(`${open.base}/api/crawl/${id}`)).json();
    expect(job.job.status).toBe("completed");
    expect(job.job.hasZip).toBe(true);
    expect(job.job.stats.pagesCrawled).toBeGreaterThanOrEqual(10);

    const zipRes = await fetch(`${open.base}/api/crawl/${id}/download`);
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("content-type")).toBe("application/zip");
    expect(zipRes.headers.get("content-disposition")).toMatch(/attachment; filename="127\.0\.0\.1-[a-f0-9]{8}\.zip"/);
    const zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));
    expect(zip.test()).toBe(true);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("index.html");
    expect(names).toContain("about/index.html");
    expect(names).toContain("_report/crawl-report.json");

    const rep = await fetch(`${open.base}/api/crawl/${id}/report/crawl-report.html`);
    expect(rep.status).toBe(200);
    expect(rep.headers.get("content-security-policy")).toContain("sandbox");
    expect((await fetch(`${open.base}/api/crawl/${id}/report/failed-urls.txt`)).status).toBe(200);
    expect((await fetch(`${open.base}/api/crawl/${id}/report/secret.txt`)).status).toBe(404);

    const hist = await (await fetch(open.base + "/api/crawl")).json();
    expect(hist.jobs.some((j: any) => j.id === id && j.status === "completed")).toBe(true);

    expect((await fetch(`${open.base}/api/crawl/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${open.base}/api/crawl/${id}`)).status).toBe(404);
    expect(fs.existsSync(path.join(dataDir, id))).toBe(false);
  });

  it("pause / resume / cancel through the API", async () => {
    fx.slowMs = 200;
    try {
      const { id } = await (await post(open.base, { url: fx.url + "/slow/1", confirmPermission: true, options: { concurrency: 1, useSitemap: false, maxDepth: 30, delayMs: 0 } })).json();
      const ctl = (action: string) => fetch(`${open.base}/api/crawl/${id}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      await new Promise((r) => setTimeout(r, 900));
      expect((await ctl("pause")).status).toBe(200);
      await new Promise((r) => setTimeout(r, 500));
      const a = (await (await fetch(`${open.base}/api/crawl/${id}`)).json()).job;
      expect(a.status).toBe("paused");
      await new Promise((r) => setTimeout(r, 700));
      const b = (await (await fetch(`${open.base}/api/crawl/${id}`)).json()).job;
      expect(b.stats.pagesCrawled).toBe(a.stats.pagesCrawled);
      expect((await ctl("resume")).status).toBe(200);
      await new Promise((r) => setTimeout(r, 900));
      const c = (await (await fetch(`${open.base}/api/crawl/${id}`)).json()).job;
      expect(c.status).toBe("running");
      expect(c.stats.pagesCrawled).toBeGreaterThan(b.stats.pagesCrawled);
      expect((await ctl("cancel")).status).toBe(200);
      const events = await readSse(`${open.base}/api/crawl/${id}/events`, (t) => t === "done");
      expect(events.at(-1)!.data.status).toBe("cancelled");
      const d = (await (await fetch(`${open.base}/api/crawl/${id}`)).json()).job;
      expect(d.status).toBe("cancelled");
      expect(d.hasZip).toBe(true);
      expect((await ctl("pause")).status).toBe(409); // no longer running
      await fetch(`${open.base}/api/crawl/${id}`, { method: "DELETE" });
    } finally {
      fx.slowMs = 0;
    }
  });
});
