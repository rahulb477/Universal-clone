#!/usr/bin/env node
// Verify the production dependency using the same arguments as the worker.
// The compressed browser remains in node_modules; runtime extraction is private
// and does not depend on this build-time temporary directory being persisted.
import { applyChromiumEnv } from "./chromium-env.mjs";
import { chromium } from "playwright-core";

const found = await applyChromiumEnv();
if (!found.ok) throw new Error(`Chromium preparation failed: ${found.reason}`);
const args = ["--disable-dev-shm-usage", "--disable-gpu"];
if (process.env.CRAWLER_CHROMIUM_SANDBOX !== "1") args.push("--no-sandbox");
try {
  const browser = await chromium.launch({ executablePath: found.executablePath, headless: true, args });
  try {
    const page = await browser.newPage();
    await page.setContent("<p>Chromium ready</p>");
    if (await page.textContent("p") !== "Chromium ready") throw new Error("Browser page check failed");
  } finally {
    await browser.close();
  }
  console.log(`[chromium] launched ${found.version} via ${found.source}`);
} catch (error) {
  console.error("[chromium] launch failed:", error);
  process.exitCode = 1;
}
