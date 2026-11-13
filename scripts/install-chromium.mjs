#!/usr/bin/env node
/**
 * Build-time Chromium install for the worker image (`npm run chromium:install`).
 *
 * A deployed worker must have a browser. Where `npx playwright-core install --with-deps` works, that is
 * the best result: a matched browser plus the system libraries it needs. It needs root and apt, though,
 * and it needs cdn.playwright.dev to be reachable.
 *
 * So this tries, in order:
 *   1. `playwright-core install --with-deps chromium`   (browser + OS libraries)
 *   2. `playwright-core install chromium`               (browser only; image already has the libraries)
 *   3. nothing — the worker falls back to `@sparticuz/chromium`, a real Chromium shipped as an npm package
 *
 * Whatever happens, the result is verified with the worker's own resolver (scripts/chromium-env.mjs). If no
 * browser is usable, this exits 1, so a broken image fails the build instead of failing every crawl later.
 */
import { spawnSync } from "node:child_process";
import { ensureChromium } from "./chromium-env.mjs";

const attempts = [
  ["chromium + system libraries", ["install", "--with-deps", "chromium"]],
  ["browser only", ["install", "chromium"]],
];

for (const [label, args] of attempts) {
  console.log(`[chromium] trying playwright-core ${args.join(" ")} (${label})`);
  const r = spawnSync("playwright-core", args, { stdio: "inherit", env: process.env });
  if (r.status === 0) {
    console.log(`[chromium] installed via playwright-core (${label})`);
    break;
  }
  console.log(`[chromium] that failed (exit ${r.status ?? r.signal}); trying the next option`);
}

const found = await ensureChromium();
if (!found.ok) {
  console.error("[chromium] no usable browser. The worker would exit at start. Reasons:");
  for (const reason of found.reasons ?? []) console.error(`  - ${reason}`);
  process.exit(1);
}

console.log(`[chromium] ${found.version} via ${found.source}`);
if (found.source === "@sparticuz/chromium") {
  console.warn("[chromium] Playwright's browser is not installed; the worker will use the npm-packaged Chromium.");
}
