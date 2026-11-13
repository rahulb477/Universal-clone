import fs from "node:fs";
import path from "node:path";
// @ts-expect-error plain ESM helper shared with the worker start script
import { applyChromiumEnv } from "../../scripts/chromium-env.mjs";

/**
 * Resolves a real Chromium once for the whole run and records what was used. Browser tests do not
 * skip when it is missing: `requireChromium()` (tests/helpers.ts) fails them with the exact reason.
 */
export default async function setup() {
  const r = await applyChromiumEnv();
  const out = path.resolve(__dirname, "../../.test-artifacts");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "chromium.json"), JSON.stringify(r, null, 2));
  if (r.ok) {
    process.env.UC_CHROMIUM_SOURCE = r.source;
    process.env.UC_CHROMIUM_VERSION = r.version;
    console.log(`[setup] Chromium: ${r.version} via ${r.source} (${r.executablePath})`);
  } else {
    process.env.UC_CHROMIUM_ERROR = r.reason;
    console.error(`[setup] Chromium is NOT available: ${r.reason}`);
  }
}
