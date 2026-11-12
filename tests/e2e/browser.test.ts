import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Renderer } from "@/lib/crawler/renderer";
import { cleanup, has, read, runCrawl, type Run } from "../helpers";
import { startExternal, startFixture, type Fixture } from "../fixtures/site";

let fx: Fixture;
let ext: Awaited<ReturnType<typeof startExternal>>;
let renderer: Renderer | null = null;
const runs: Run[] = [];
let chromiumOk = false;

beforeAll(async () => {
  ext = await startExternal();
  fx = await startFixture(ext.url);
  renderer = await Renderer.create(true);
  chromiumOk = !!renderer;
  if (!chromiumOk) console.warn("Chromium unavailable, browser tests will be skipped:", Renderer.lastError);
});
afterAll(async () => {
  await renderer?.close();
  runs.forEach(cleanup);
  await fx?.close();
  await ext?.close();
});

const t = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => (chromiumOk ? fn() : ctx.skip()));

describe("JavaScript rendering", () => {
  t("6. fast mode misses JS-generated links; JS mode finds them", async () => {
    const fast = await runCrawl(fx.url + "/js", { useSitemap: false, maxDepth: 2 });
    runs.push(fast);
    expect(has(fast, "js-found/index.html")).toBe(false);
    // (the image URL appears as a string literal in the inline script, so the static scan may still pick it up;
    // what fast mode cannot do is see the *link* that the script inserts into the DOM)

    const js = await runCrawl(fx.url + "/js", { renderMode: "js", useSitemap: false, maxDepth: 2 });
    runs.push(js);
    expect(js.result.status).toBe("completed");
    expect(js.report.renderMode.effective).toBe("js");
    expect(has(js, "js-found/index.html")).toBe(true);
    expect(has(js, "img/js-img.png")).toBe(true);
    const html = read(js, "js/index.html");
    expect(html).toContain('href="../js-found/index.html"');
    expect(html).not.toContain("<script"); // rendered snapshot, scripts removed
    expect(js.report.pages.find((p: any) => p.url.endsWith("/js")).renderedWith).toBe("js");
  });

  t("7. SPA: client-side routes are discovered, rendered and saved", async () => {
    const fast = await runCrawl(fx.url + "/spa", { useSitemap: false, maxDepth: 3 });
    runs.push(fast);
    expect(has(fast, "spa/a/index.html")).toBe(false); // static HTML has no links

    const spa = await runCrawl(fx.url + "/spa", { renderMode: "js", useSitemap: false, maxDepth: 3 });
    runs.push(spa);
    expect(read(spa, "spa/index.html")).toContain("SPA Home");
    expect(read(spa, "spa/a/index.html")).toContain("SPA Page A");
    expect(read(spa, "spa/b/index.html")).toContain("SPA Page B");
    expect(has(spa, "img/spa-spaa.png")).toBe(true);
    expect(read(spa, "spa/index.html")).toContain('href="a/index.html"');
  });

  t("8. lazy-loaded images triggered by scrolling are captured", async () => {
    const r = await runCrawl(fx.url + "/lazy", { renderMode: "js", useSitemap: false, maxDepth: 0 });
    runs.push(r);
    expect(has(r, "img/lazy-1.png")).toBe(true);
    expect(has(r, "img/lazy-2.png")).toBe(true); // below the fold: only loaded because the renderer scrolls
    expect(read(r, "lazy/index.html")).toContain('src="../img/lazy-2.png"');
    expect(fx.hits.get("/img/lazy-2.png")).toBeGreaterThan(0);
  });

  t("full mode clicks safe 'load more' controls; js mode does not", async () => {
    const js = await runCrawl(fx.url + "/loadmore", { renderMode: "js", useSitemap: false, maxDepth: 2 });
    runs.push(js);
    expect(has(js, "loaded-item/index.html")).toBe(false);
    const full = await runCrawl(fx.url + "/loadmore", { renderMode: "full", useSitemap: false, maxDepth: 2 });
    runs.push(full);
    expect(has(full, "loaded-item/index.html")).toBe(true);
    expect(full.report.renderMode.effective).toBe("full");
  });

  t("browser requests to private addresses are blocked by the render guard", async () => {
    // Renderer created with allowPrivate=false must refuse the fixture (127.0.0.1).
    const strict = await Renderer.create(false);
    expect(strict).not.toBeNull();
    try {
      const before = fx.hits.size;
      await expect(strict!.render(fx.url + "/", { mode: "js", timeoutMs: 5000 })).rejects.toThrow();
      expect(fx.hits.size).toBe(before);
    } finally {
      await strict!.close();
    }
  });
});

describe("offline navigation in a real browser", () => {
  t("19. the extracted ZIP works offline: click through nested pages with the network blocked", async () => {
    const r = await runCrawl(fx.url + "/", { maxDepth: 4, maxPages: 40, maxQueryVariantsPerPath: 3 });
    runs.push(r);
    const ctx = await renderer!.browser.newContext();
    const requested: string[] = [];
    await ctx.route(/^https?:/i, (route) => {
      requested.push(route.request().url());
      return route.abort();
    });
    try {
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(pathToFileURL(path.join(r.out, "index.html")).href);
      expect(await page.textContent("h1")).toBe("Home");
      await page.click("nav >> text=Services");
      expect(await page.textContent("h1")).toBe("Services");
      await page.click("text=Web development");
      expect(await page.textContent("h1")).toBe("Web Development");
      await page.click("text=Pricing");
      await page.click("text=Enterprise");
      expect(await page.textContent("h1")).toBe("Enterprise");
      expect(page.url().startsWith("file://")).toBe(true);
      expect(page.url()).toContain("services/web-development/pricing/enterprise/index.html");
      await page.click("nav >> text=Products");
      await page.click("text=P123");
      expect(await page.textContent("h1")).toBe("Product 123");
      await page.click("nav >> text=Home");
      await page.click("text=page 2");
      expect(await page.textContent("h1")).toBe("Home page 2");
      // stylesheet + background assets resolved from disk
      const bg = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      expect(bg).toBeTruthy();
      // a link to a page that was never archived shows the local fallback page instead of a browser error
      await page.click("nav >> text=Home");
      await page.click("text=secret");
      expect(await page.textContent("h1")).toBe("This page was not archived");
      expect(await page.textContent("#u")).toContain("/secret");
      // not a single request tried to leave the disk
      expect(requested).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  t("offline copy of a rendered SPA keeps working without scripts", async () => {
    const r = await runCrawl(fx.url + "/spa", { renderMode: "js", useSitemap: false, maxDepth: 3 });
    runs.push(r);
    const ctx = await renderer!.browser.newContext();
    await ctx.route(/^https?:/i, (route) => route.abort());
    try {
      const page = await ctx.newPage();
      await page.goto(pathToFileURL(path.join(r.out, "index.html")).href); // index.html redirects to the start page
      await page.waitForURL(/spa\/index\.html$/);
      await page.click('nav >> a:text-is("A")');
      expect(await page.textContent("h1")).toBe("SPA Page A");
      await page.click('nav >> a:text-is("B")');
      expect(await page.textContent("h1")).toBe("SPA Page B");
    } finally {
      await ctx.close();
    }
  });
});

describe("visual comparison", () => {
  t("20. screenshots the live page and the offline copy at three viewports and measures the difference", async () => {
    const r = await runCrawl(fx.url + "/about", { useSitemap: false, maxDepth: 0, visualCompare: true, visualMaxPages: 1 });
    runs.push(r);
    const rows = r.report.visual as any[];
    expect(rows).toHaveLength(3);
    expect(rows.map((x) => x.viewport)).toEqual(["desktop", "tablet", "mobile"]);
    for (const row of rows) {
      expect(row.error).toBeUndefined();
      expect(typeof row.mismatchPercent).toBe("number");
      expect(row.sourceSize.w).toBeGreaterThan(0);
      expect(has(r, "_report/" + row.files.diff)).toBe(true);
      expect(has(r, "_report/" + row.files.source)).toBe(true);
      expect(has(r, "_report/" + row.files.local)).toBe(true);
      expect(row.missingResources).toEqual([]); // nothing in the offline copy still needs the network
      console.log(`visual ${row.viewport}: ${row.mismatchPercent.toFixed(3)}% mismatch — ${row.verdict}`);
    }
    expect(read(r, "_report/crawl-report.html")).toContain("Pixel mismatch");
  });

  t("visual comparison flags resources that are missing offline", async () => {
    // /assets-test references a missing image and a soft-404 image: they stay pointing at the live URL.
    const r = await runCrawl(fx.url + "/assets-test", { useSitemap: false, maxDepth: 0, visualCompare: true, visualMaxPages: 1 });
    runs.push(r);
    const rows = r.report.visual as any[];
    expect(rows.some((x) => x.missingResources.some((u: string) => u.includes("missing.png") || u.includes("soft404.png")))).toBe(true);
  });
});
