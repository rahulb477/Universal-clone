import { describe, expect, it } from "vitest";
import { cleanup, has, read, runCrawl } from "../helpers";
import { Crawler } from "@/lib/crawler/engine";

// Opt-in: LIVE=1 npx vitest run tests/live  (needs internet access; uses a public site built for crawling practice)
describe.skipIf(!process.env.LIVE)("live public website (real DNS)", () => {
  it("crawls quotes.toscrape.com: pagination, tag pages, assets, offline links", async () => {
    const r = await runCrawl("http://quotes.toscrape.com/", { maxPages: 60, maxDepth: 2, delayMs: 50, requestTimeoutMs: 15000 }, () => {});
    try {
      console.log(JSON.stringify(r.report.totals), r.result.error ?? "");
      expect(r.result.status).toBe("completed");
      expect(r.report.totals.pagesDownloaded).toBeGreaterThan(5);
      expect(r.files.some((f) => f.startsWith("page/2"))).toBe(true);
      // the site's own bootstrap fonts return 404 on the live site: they must be reported, not hidden
      expect(r.report.missingAssets.length).toBeGreaterThan(0);
      expect(r.files.some((f) => f.startsWith("tag/"))).toBe(true);
      expect(has(r, "static/bootstrap.min.css")).toBe(true);
      expect(read(r, "index.html")).toContain('href="page/2/index.html"');
      expect(r.zip!.test()).toBe(true);
    } finally {
      cleanup(r);
    }
  });
  it("strict policy: private targets are refused when allowPrivateNetworks is not set", async () => {
    const c = new Crawler("http://127.0.0.1:1/", {}, { workDir: "/tmp/live-ssrf" });
    expect((await c.run()).status).toBe("failed");
  });
});
