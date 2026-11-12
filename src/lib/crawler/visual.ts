import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { Renderer } from "./renderer";
import { autoScroll, stabilize } from "./renderer";
import { hash6 } from "./url";

export const VIEWPORTS = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
];

export interface VisualRow {
  page: string;
  localPath: string;
  viewport: string;
  sourceSize: { w: number; h: number };
  localSize: { w: number; h: number };
  mismatchPercent: number | null;
  verdict: string;
  missingResources: string[];
  consoleErrors: number;
  files?: { source: string; local: string; diff: string };
  error?: string;
}

export function compareImages(a: Buffer, b: Buffer) {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  const w = Math.min(A.width, B.width);
  const h = Math.min(A.height, B.height);
  const crop = (img: PNG) => {
    const out = new PNG({ width: w, height: h });
    PNG.bitblt(img, out, 0, 0, w, h, 0, 0);
    return out;
  };
  const ca = crop(A);
  const cb = crop(B);
  const diff = new PNG({ width: w, height: h });
  const mismatched = w * h === 0 ? 0 : pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.1 });
  return {
    sourceSize: { w: A.width, h: A.height },
    localSize: { w: B.width, h: B.height },
    mismatched,
    total: w * h,
    percent: w * h === 0 ? 100 : (mismatched / (w * h)) * 100,
    diffPng: PNG.sync.write(diff),
  };
}

export function verdictFor(percent: number, sizeMatches: boolean): string {
  const dim = sizeMatches ? "" : "; page dimensions differ";
  if (percent < 1) return `close match (<1% pixels differ)${dim}`;
  if (percent < 10) return `minor differences (${percent.toFixed(1)}% pixels differ)${dim}`;
  return `significant differences (${percent.toFixed(1)}% pixels differ)${dim}`;
}

export interface VisualInput {
  siteDir: string;
  reportDir: string;
  pages: Array<{ url: string; localPath: string }>;
  timeoutMs: number;
  signal?: AbortSignal;
  log: (msg: string) => void;
}

async function shot(page: import("playwright-core").Page, width: number): Promise<Buffer> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 900);
  return page.screenshot({ fullPage: true, type: "png", clip: height > 6000 ? { x: 0, y: 0, width, height: 6000 } : undefined, animations: "disabled" });
}

/**
 * Renders each page from the live site and from the offline copy (file://, with all
 * http(s) requests blocked so anything still depending on the network is detected),
 * then compares the screenshots pixel by pixel.
 */
export async function runVisualComparison(renderer: Renderer, input: VisualInput): Promise<VisualRow[]> {
  const rows: VisualRow[] = [];
  const outDir = path.join(input.reportDir, "visual");
  await fs.promises.mkdir(outDir, { recursive: true });
  for (const p of input.pages) {
    for (const vp of VIEWPORTS) {
      if (input.signal?.aborted) return rows;
      const base: VisualRow = {
        page: p.url,
        localPath: p.localPath,
        viewport: vp.name,
        sourceSize: { w: 0, h: 0 },
        localSize: { w: 0, h: 0 },
        mismatchPercent: null,
        verdict: "not compared",
        missingResources: [],
        consoleErrors: 0,
      };
      try {
        // Source (live) screenshot.
        const sctx = await renderer.guardedContext({ width: vp.width, height: vp.height });
        let srcPng: Buffer;
        try {
          const sp = await sctx.newPage();
          await sp.goto(p.url, { waitUntil: "load", timeout: input.timeoutMs });
          await sp.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
          await autoScroll(sp);
          await stabilize(sp, 2000);
          srcPng = await shot(sp, vp.width);
        } finally {
          await sctx.close().catch(() => {});
        }
        // Offline screenshot.
        const lctx = await renderer.browser.newContext({ viewport: { width: vp.width, height: vp.height }, serviceWorkers: "block" });
        let locPng: Buffer;
        const missing = new Set<string>();
        let consoleErrors = 0;
        try {
          await lctx.route(/^https?:/i, (route) => {
            missing.add(route.request().url());
            return route.abort("blockedbyclient");
          });
          const lp = await lctx.newPage();
          lp.on("requestfailed", (r) => {
            if (r.url().startsWith("file:")) missing.add(r.url());
          });
          lp.on("console", (m) => {
            if (m.type() === "error") consoleErrors++;
          });
          await lp.goto(pathToFileURL(path.join(input.siteDir, p.localPath)).href, { waitUntil: "load", timeout: input.timeoutMs });
          await autoScroll(lp);
          await stabilize(lp, 2000);
          locPng = await shot(lp, vp.width);
        } finally {
          await lctx.close().catch(() => {});
        }
        const cmp = compareImages(srcPng, locPng);
        const stem = `${hash6(p.url)}-${vp.name}`;
        await fs.promises.writeFile(path.join(outDir, `${stem}-source.png`), srcPng);
        await fs.promises.writeFile(path.join(outDir, `${stem}-offline.png`), locPng);
        await fs.promises.writeFile(path.join(outDir, `${stem}-diff.png`), cmp.diffPng);
        rows.push({
          ...base,
          sourceSize: cmp.sourceSize,
          localSize: cmp.localSize,
          mismatchPercent: cmp.percent,
          verdict: verdictFor(cmp.percent, cmp.sourceSize.w === cmp.localSize.w && cmp.sourceSize.h === cmp.localSize.h),
          missingResources: [...missing].slice(0, 50),
          consoleErrors,
          files: { source: `visual/${stem}-source.png`, local: `visual/${stem}-offline.png`, diff: `visual/${stem}-diff.png` },
        });
        input.log(`${p.url} [${vp.name}]: ${cmp.percent.toFixed(2)}% pixels differ`);
      } catch (e) {
        rows.push({ ...base, error: (e as Error).message.split("\n")[0], verdict: "comparison failed" });
      }
    }
  }
  return rows;
}
