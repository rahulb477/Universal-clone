import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crawler } from "@/lib/crawler/engine";
import type { LogEvent } from "@/lib/crawler/types";
import { cleanup, FAST, finishRun, has, read, runCrawl, type Run } from "../helpers";
import { startExternal, startFixture, type Fixture } from "../fixtures/site";

let fx: Fixture;
let ext: Awaited<ReturnType<typeof startExternal>>;
let base: Run;
const runs: Run[] = [];

const pageFor = (run: Run, suffix: string) => run.report.pages.find((p: any) => p.url === suffix || p.url.endsWith(suffix));

beforeAll(async () => {
  ext = await startExternal();
  fx = await startFixture(ext.url);
  base = await runCrawl(fx.url + "/", { maxQueryVariantsPerPath: 5, maxPages: 300 });
  runs.push(base);
});

afterAll(async () => {
  runs.forEach(cleanup);
  await fx?.close();
  await ext?.close();
});

describe("multi-page crawl from one URL (fast mode)", () => {
  it("completes and reports honest totals", () => {
    expect(base.result.status).toBe("completed");
    expect(base.report.totals.pagesDownloaded).toBeGreaterThanOrEqual(20);
    expect(base.report.totals.pagesDiscovered).toBeGreaterThan(base.report.totals.pagesDownloaded - 1);
    expect(base.report.totals.assetsDownloaded).toBeGreaterThan(10);
  });

  it("1. discovers simple multi-page navigation", () => {
    for (const p of ["about", "contact", "services", "blog", "products", "team"]) expect(has(base, `${p}/index.html`), p).toBe(true);
    expect(read(base, "about/index.html")).toContain("About us");
    expect(has(base, "index.html")).toBe(true);
  });

  it("2. downloads deeply nested routes", () => {
    expect(has(base, "services/web-development/index.html")).toBe(true);
    expect(has(base, "services/web-development/pricing/index.html")).toBe(true);
    expect(has(base, "services/web-development/pricing/enterprise/index.html")).toBe(true);
    expect(has(base, "blog/article-1/index.html")).toBe(true);
    expect(has(base, "blog/article-2/index.html")).toBe(true);
  });

  it("3. treats meaningful query URLs as separate pages and normalises the rest", () => {
    expect(has(base, "products/index__id-123.html")).toBe(true);
    expect(has(base, "products/index__id-456.html")).toBe(true);
    expect(has(base, "index__category-technology.html")).toBe(true);
    expect(read(base, "products/index__id-456.html")).toContain("details of product 456");
    // tracking parameters are stripped -> about?utm_source=... collapses into /about
    expect(base.files.filter((f) => f.includes("utm") || f.includes("fbclid"))).toEqual([]);
    expect(base.result.stats.duplicateUrls).toBeGreaterThan(0);
    // /products?id=456&utm_campaign=z must not be fetched separately
    const hits456 = [...fx.hits.keys()].filter((k) => k.startsWith("/products?id=456"));
    expect(hits456).toEqual(["/products?id=456"]);
  });

  it("4. follows pagination and caps endless pagination (URL trap)", () => {
    expect(has(base, "index__page-2.html")).toBe(true);
    expect(has(base, "index__page-3.html")).toBe(true);
    for (const n of [1, 2, 3]) expect(has(base, `news/index__page-${n}.html`)).toBe(true);
    const endless = base.files.filter((f) => f.startsWith("endless/"));
    expect(endless.length).toBeLessThanOrEqual(5);
    expect(base.report.skipped.some((s: any) => /query variant limit/.test(s.reason))).toBe(true);
  });

  it("detects calendar traps", () => {
    expect(base.files.some((f) => f.startsWith("calendar/"))).toBe(false);
    expect(base.report.skipped.some((s: any) => /calendar trap/.test(s.reason))).toBe(true);
  });

  it("5. discovers pages only listed in sitemap.xml (including nested sitemaps)", () => {
    expect(has(base, "hidden/index.html")).toBe(true);
    expect(has(base, "hidden-nested/index.html")).toBe(true);
  });

  it("respects robots.txt", () => {
    expect(has(base, "secret/index.html")).toBe(false);
    expect(fx.hits.has("/secret")).toBe(false);
    expect(base.report.skipped.some((s: any) => s.url.endsWith("/secret") && /robots/.test(s.reason))).toBe(true);
  });

  it("9. rewrites CSS url() and @import and downloads backgrounds + 10. fonts", () => {
    const css = read(base, "css/main.css");
    expect(css).toContain('url("../img/bg.png")');
    expect(css).toContain('@import url("imported.css")');
    expect(css).toContain('url("http');  // the missing asset now points at the live URL, never at the local disk root
    expect(css).toContain('url("../fonts/test.woff2")');
    expect(css).toContain('url("../fonts/test.woff")');
    for (const f of ["img/bg.png", "css/imported.css", "img/imp.png", "fonts/test.woff2", "fonts/test.woff"]) expect(has(base, f), f).toBe(true);
    expect(read(base, "css/imported.css")).toContain('url("../img/imp.png")');
    expect(read(base, "assets-test/index.html")).toContain("../img/inline-bg.png");
    expect(has(base, "img/inline-bg.png")).toBe(true);
    expect(has(base, "img/style-tag.png")).toBe(true);
  });

  it("downloads icons, og:image, responsive variants, documents and JS-referenced assets", () => {
    for (const f of ["favicon.png", "img/og.png", "img/r-480.png", "img/r-960.png", "files/doc.pdf", "img/from-js.png", "js/app.js"]) expect(has(base, f), f).toBe(true);
    const home = read(base, "index.html");
    expect(home).toContain("img/r-960.png 960w");
    expect(home).toContain('content="img/og.png"');
  });

  it("8. handles lazy-loaded images (data-src) without JavaScript", () => {
    expect(has(base, "img/lazy-1.png")).toBe(true);
    expect(has(base, "img/lazy-2.png")).toBe(true);
    expect(read(base, "lazy/index.html")).toContain('src="../img/lazy-1.png"');
  });

  it("11. detects duplicate assets by content hash", () => {
    expect(base.result.stats.duplicateAssets).toBeGreaterThanOrEqual(1);
    const manifest = JSON.parse(read(base, "_report/assets-manifest.json"));
    const b = manifest.find((a: any) => a.url.endsWith("/img/dup-b.png"));
    expect(b.status).toBe("duplicate");
    expect(b.duplicateOf).toContain("dup-a.png");
    expect(has(base, "img/dup-b.png")).toBe(false);
    expect(read(base, "index.html").match(/img\/dup-a\.png/g)!.length).toBe(2); // both <img> point at one file
  });

  it("12. rewrites internal links to relative local paths and keeps external links", () => {
    const home = read(base, "index.html");
    expect(home).toContain('href="about/index.html"');
    expect(home).toContain('href="index__page-2.html"');
    expect(read(base, "services/web-development/index.html")).toContain('href="pricing/index.html"');
    expect(read(base, "services/web-development/pricing/enterprise/index.html")).toContain('href="../../../../index.html"');
    expect(read(base, "services/web-development/index.html")).toContain('<link rel="stylesheet" href="../../css/main.css">');
    expect(home.replace(/<!--[\s\S]*?-->/, "")).not.toContain(fx.url);
    expect(home).toContain(`href="${ext.url}/ext"`); // external stays absolute
    expect(read(base, "products/index.html")).toContain('href="index__id-123.html"');
    expect(read(base, "news/index__page-1.html")).toContain('href="index__page-2.html"');
  });

  it("every local link in the archive resolves to a file (offline reachability crawl)", () => {
    const seen = new Set<string>();
    const queue = ["index.html"];
    const broken: string[] = [];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const html = read(base, f);
      const $ = cheerio.load(html);
      const refs: string[] = [];
      $("a[href], link[href], img[src], script[src], source[src]").each((_, el) => {
        refs.push(($(el).attr("href") ?? $(el).attr("src") ?? "").split("#")[0]);
      });
      for (const ref of refs) {
        if (!ref) continue;
        if (/^(https?:|mailto:|data:|javascript:)/.test(ref)) continue;
        const clean = ref.split("?")[0];
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), clean));
        if (!has(base, target)) broken.push(`${f} -> ${ref}`);
        else if (target.endsWith(".html")) queue.push(target);
      }
    }
    expect(broken).toEqual([]);
    expect(seen.size).toBeGreaterThanOrEqual(20);
  });

  it("links to pages that were not archived go to a local fallback page", () => {
    const home = read(base, "index.html");
    expect(home).toMatch(/href="__offline__\/missing\.html\?u=[^"]*secret"/);
    expect(has(base, "__offline__/missing.html")).toBe(true);
    const routes = JSON.parse(read(base, "__offline__/route-map.json"));
    expect(Object.values(routes)).toContain("about/index.html");
  });

  it("redirects are aliased to the final page", () => {
    const routes = JSON.parse(read(base, "__offline__/route-map.json"));
    expect(routes[`${fx.url}/redirect`]).toBe("team/index.html");
    expect(read(base, "index.html")).toMatch(/href="team\/index\.html"[^>]*>redirect</);
  });

  it("17. never leaves the domain scope", () => {
    expect(ext.hits.size).toBe(0);
    expect(base.report.externalLinks.some((l: string) => l.startsWith(ext.url))).toBe(true);
    const f = base.report.failures.find((x: any) => x.url.endsWith("/redirect-external"));
    expect(f.error).toMatch(/authorised domain scope/);
    expect(base.files.some((x) => x.startsWith("_sub/") || x.startsWith("_ext/"))).toBe(false);
  });

  it("14. recovers from transient failures and reports permanent ones", () => {
    expect(has(base, "flaky/index.html")).toBe(true); // 500, 500, 200
    expect(has(base, "ratelimited/index.html")).toBe(true); // 429 + Retry-After
    expect(has(base, "img/flaky.png")).toBe(true); // asset 503, 503, 200
    expect(fx.hits.get("/flaky")).toBe(3);
    expect(fx.hits.get("/nope")).toBe(1); // 404 is never retried
    expect(fx.hits.get("/always-500")).toBe(4); // initial + 3 retries
    expect(base.logs.some((l: LogEvent) => l.tag === "RETRY")).toBe(true);
    const failed = base.report.failures;
    const by = (s: string) => failed.find((f: any) => f.url.endsWith(s));
    expect(by("/nope").status).toBe(404);
    expect(by("/always-500").status).toBe(500);
    expect(by("/always-500").attempts).toBe(4);
    expect(by("/img/missing.png").kind).toBe("asset");
    expect(by("/soft404.png").error).toMatch(/HTML page/);
    const txt = read(base, "_report/failed-urls.txt");
    expect(txt).toContain("/nope");
    expect(txt).toContain("/always-500");
  });

  it("13. produces an intact ZIP with safe entry names and all report files", () => {
    expect(base.zip!.test()).toBe(true);
    const names = base.zip!.getEntries().map((e) => e.entryName);
    expect(names.every((n) => !n.includes("..") && !n.startsWith("/") && !n.includes("\\"))).toBe(true);
    for (const f of ["crawl-report.json", "crawl-report.html", "failed-urls.txt", "discovered-urls.txt", "assets-manifest.json"]) {
      expect(names).toContain(`_report/${f}`);
    }
    expect(read(base, "_report/discovered-urls.txt")).toContain("/services/web-development");
    expect(read(base, "_report/crawl-report.html")).toContain("Crawl report");
    expect(base.report.unsupportedDynamicFunctionality.forms.length).toBeGreaterThan(0);
    expect(base.report.visualComparison.note).toMatch(/not requested/);
  });

  it("work directories are cleaned up after packaging (raw + site removed)", () => {
    expect(fs.existsSync(path.join(base.workDir, "raw"))).toBe(false);
    expect(fs.existsSync(path.join(base.workDir, "site"))).toBe(false);
    expect(fs.existsSync(path.join(base.workDir, "site.zip"))).toBe(true);
  });
});

describe("limits and quotas", () => {
  it("enforces max depth", async () => {
    const r = await runCrawl(fx.url + "/", { maxDepth: 1, useSitemap: false });
    runs.push(r);
    expect(has(r, "services/index.html")).toBe(true);
    expect(has(r, "services/web-development/index.html")).toBe(false);
    expect(r.report.skipped.some((s: any) => /max depth/.test(s.reason))).toBe(true);
  });

  it("enforces max pages", async () => {
    const r = await runCrawl(fx.url + "/", { maxPages: 4, useSitemap: false });
    runs.push(r);
    expect(r.result.stats.pagesCrawled + r.result.stats.pagesFailed).toBeLessThanOrEqual(4);
    expect(r.report.skipped.some((s: any) => /max pages/.test(s.reason))).toBe(true);
  });

  it("18. enforces the total download size quota", async () => {
    const limit = 20 * 1024;
    const r = await runCrawl(fx.url + "/", { maxTotalSize: limit, useSitemap: false });
    runs.push(r);
    expect(r.result.stats.bytesDownloaded).toBeLessThanOrEqual(limit);
    expect(r.result.stats.stopReason ?? r.result.stats.status).toBeTruthy();
    expect(r.report.totals.pagesDownloaded).toBeLessThan(base.report.totals.pagesDownloaded);
  });

  it("18. enforces the per-file size limit while streaming", async () => {
    const r = await runCrawl(fx.url + "/big", { maxFileSize: 100 * 1024, maxDepth: 1, useSitemap: false });
    runs.push(r);
    expect(has(r, "files/big.bin")).toBe(false);
    const manifest = JSON.parse(read(r, "_report/assets-manifest.json"));
    const big = manifest.find((a: any) => a.url.endsWith("big.bin"));
    expect(big.status).toBe("skipped");
    expect(big.error).toMatch(/limit/);
  });

  it("18. enforces the wall-clock limit and still packages partial results", async () => {
    fx.slowMs = 250;
    try {
      const r = await runCrawl(fx.url + "/slow/1", { maxDurationMs: 1500, concurrency: 1, useSitemap: false, maxDepth: 40 });
      runs.push(r);
      expect(r.result.status).toBe("completed");
      expect(r.result.stats.stopReason).toMatch(/time limit/);
      expect(r.report.totals.pagesDownloaded).toBeGreaterThan(1);
      expect(r.report.totals.pagesDownloaded).toBeLessThan(40);
    } finally {
      fx.slowMs = 0;
    }
  });
});

describe("security at crawler level", () => {
  const blocked = async (url: string) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-ssrf-"));
    const c = new Crawler(url, FAST, { workDir }); // allowPrivateNetworks NOT set
    const res = await c.run();
    fs.rmSync(workDir, { recursive: true, force: true });
    return res;
  };
  it("16. refuses to crawl localhost, private ranges and metadata endpoints", async () => {
    const before = fx.hits.size;
    for (const u of [fx.url + "/", "http://localhost:1/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://[::1]/", "file:///etc/passwd"]) {
      const r = await blocked(u);
      expect(r.status, u).toBe("failed");
      expect(r.error, u).toMatch(/Blocked/);
    }
    expect(fx.hits.size).toBe(before);
  });
});

describe("control: pause, resume, cancel, state recovery", () => {
  it("15. cancels gracefully and packages the partial download", async () => {
    fx.slowMs = 150;
    try {
      let crawler!: Crawler;
      const t0 = Date.now();
      const r = await runCrawl(fx.url + "/slow/1", { concurrency: 1, useSitemap: false, maxDepth: 40 }, (c) => {
        crawler = c;
        let done = 0;
        c.on("log", (l: LogEvent) => {
          if (l.tag === "COMPLETE" && ++done === 3) c.cancel();
        });
      });
      runs.push(r);
      expect(r.result.status).toBe("cancelled");
      expect(Date.now() - t0).toBeLessThan(10000);
      expect(r.result.stats.pagesCrawled).toBeGreaterThanOrEqual(3);
      expect(r.result.stats.pagesCrawled).toBeLessThan(20);
      expect(r.zip!.test()).toBe(true);
      expect(has(r, "slow/1/index.html")).toBe(true);
      expect(crawler.status).toBe("cancelled");
    } finally {
      fx.slowMs = 0;
    }
  });

  it("pause stops progress and resume continues", async () => {
    fx.slowMs = 120;
    try {
      let crawler!: Crawler;
      let pausedAt = -1;
      let frozen = false;
      const p = runCrawl(fx.url + "/slow/1", { concurrency: 1, useSitemap: false, maxDepth: 5 }, (c) => {
        crawler = c;
        c.once("log", () => {});
        c.on("log", (l: LogEvent) => {
          if (l.tag === "COMPLETE" && pausedAt < 0) {
            crawler.pause();
            pausedAt = crawler.getStats().pagesCrawled;
            setTimeout(() => {
              // after in-flight work drains nothing new may start
              const a = crawler.getStats().pagesCrawled;
              setTimeout(() => {
                frozen = crawler.getStats().pagesCrawled === a && crawler.status === "paused";
                crawler.resumeCrawl();
              }, 600);
            }, 400);
          }
        });
      });
      const r = await p;
      runs.push(r);
      expect(frozen).toBe(true);
      expect(r.result.status).toBe("completed");
      expect(r.report.totals.pagesDownloaded).toBe(6); // slow/1..5 + depth limit -> /slow/1../slow/6 (depth 0..5)
    } finally {
      fx.slowMs = 0;
    }
  });

  it("resumes from a saved snapshot without re-downloading finished pages", async () => {
    fx.slowMs = 100;
    fx.hits.clear();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-resA-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-resB-"));
    try {
      const a = new Crawler(fx.url + "/slow/1", { ...FAST, concurrency: 1, useSitemap: false, maxDepth: 7 }, { workDir: dirA, allowPrivateNetworks: true });
      let n = 0;
      let snapshotted: Promise<void> | null = null;
      a.on("log", (l: LogEvent) => {
        if (l.tag === "COMPLETE" && ++n === 3) {
          a.pause();
          snapshotted = (async () => {
            await new Promise((r) => setTimeout(r, 400));
            await (a as unknown as { saveState(): Promise<void> }).saveState();
            fs.cpSync(dirA, dirB, { recursive: true });
            a.cancel();
            a.resumeCrawl();
          })();
        }
      });
      await a.run();
      await snapshotted;
      expect(fs.existsSync(path.join(dirB, "state.json"))).toBe(true);
      const before = new Map(fx.hits);
      const b = new Crawler(fx.url + "/slow/1", { ...FAST, concurrency: 1, useSitemap: false, maxDepth: 7 }, { workDir: dirB, allowPrivateNetworks: true, resume: true });
      const logs: LogEvent[] = [];
      b.on("log", (l: LogEvent) => logs.push(l));
      const res = await b.run();
      const run = finishRun({ result: res, crawler: b, logs, workDir: dirB });
      expect(res.status).toBe("completed");
      expect(run.report.totals.pagesDownloaded).toBe(8);
      expect(logs.some((l) => /Resumed saved crawl/.test(l.message))).toBe(true);
      // the 3 pages stored before the snapshot were not requested again by the resumed crawl
      for (const i of [1, 2, 3]) expect(fx.hits.get(`/slow/${i}`)).toBe(before.get(`/slow/${i}`));
    } finally {
      fx.slowMs = 0;
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe("query-parameter configuration", () => {
  it("crawlQueryParams=false collapses query variants", async () => {
    const r = await runCrawl(fx.url + "/", { crawlQueryParams: false, useSitemap: false, maxDepth: 2 });
    runs.push(r);
    expect(r.files.filter((f) => /__/.test(f) && f.endsWith(".html") && !f.startsWith("__offline__"))).toEqual([]);
    expect(has(r, "products/index.html")).toBe(true);
  });
  it("include / exclude patterns are honoured", async () => {
    const r = await runCrawl(fx.url + "/", { excludePatterns: ["/blog*", "/services*"], useSitemap: false, maxDepth: 3 });
    runs.push(r);
    expect(has(r, "blog/index.html")).toBe(false);
    expect(has(r, "services/index.html")).toBe(false);
    expect(has(r, "about/index.html")).toBe(true);
    const only = await runCrawl(fx.url + "/", { includePatterns: ["/blog*"], useSitemap: false, maxDepth: 3 });
    runs.push(only);
    expect(has(only, "blog/article-1/index.html")).toBe(true);
    expect(has(only, "about/index.html")).toBe(false);
  });
  it("assets can be disabled", async () => {
    const r = await runCrawl(fx.url + "/about", { downloadAssets: false, useSitemap: false, maxDepth: 0 });
    runs.push(r);
    expect(has(r, "css/main.css")).toBe(false);
    expect(r.report.totals.assetsDiscovered).toBe(0);
  });
});
