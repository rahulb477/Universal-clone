// Resolves a Chromium binary that Playwright can drive, and the environment it needs.
//
// Order:
//   1. CHROMIUM_PATH (explicit operator choice)
//   2. Playwright's own managed browser (`npx playwright-core install chromium`)
//   3. the `@sparticuz/chromium` npm package (a real Chromium build shipped through the npm registry),
//      used where cdn.playwright.dev cannot be reached. Its shared libraries (NSS, NSPR, …) are
//      unpacked next to it and put on LD_LIBRARY_PATH.
//
// Never silently returns "no browser": callers get a result with `ok: false` and the exact reason.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function version(exe, env) {
  return execFileSync(exe, ["--version"], { env, encoding: "utf8", timeout: 30000 }).trim();
}

export async function ensureChromium() {
  const reasons = [];
  if (process.env.CHROMIUM_PATH) {
    try {
      return { ok: true, source: "CHROMIUM_PATH", executablePath: process.env.CHROMIUM_PATH, libraryPath: process.env.LD_LIBRARY_PATH || "", version: version(process.env.CHROMIUM_PATH, process.env) };
    } catch (e) {
      reasons.push(`CHROMIUM_PATH=${process.env.CHROMIUM_PATH} does not run: ${String(e.message).split("\n")[0]}`);
    }
  }
  try {
    const { chromium } = require("playwright-core");
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) return { ok: true, source: "playwright", executablePath: exe, libraryPath: process.env.LD_LIBRARY_PATH || "", version: version(exe, process.env) };
    reasons.push(`Playwright's managed Chromium is not installed (${exe || "no path"})`);
  } catch (e) {
    reasons.push(`playwright-core: ${String(e.message).split("\n")[0]}`);
  }
  try {
    let pkgDir = path.dirname(require.resolve("@sparticuz/chromium"));
    while (!fs.existsSync(path.join(pkgDir, "bin", "al2023.tar.br")) && path.dirname(pkgDir) !== pkgDir) pkgDir = path.dirname(pkgDir);
    const mod = await import("@sparticuz/chromium");
    const sparticuz = mod.default ?? mod;
    const exe = await sparticuz.executablePath();
    const libRoot = path.join(os.tmpdir(), "universal-clone-chromium-libs");
    const libDir = path.join(libRoot, "lib");
    if (!fs.existsSync(path.join(libDir, "libnspr4.so"))) {
      fs.mkdirSync(libRoot, { recursive: true });
      const tar = path.join(libRoot, "al2023.tar");
      fs.writeFileSync(tar, zlib.brotliDecompressSync(fs.readFileSync(path.join(pkgDir, "bin", "al2023.tar.br"))));
      execFileSync("tar", ["xf", tar, "-C", libRoot]);
      fs.rmSync(tar, { force: true });
    }
    const libraryPath = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    return { ok: true, source: "@sparticuz/chromium", executablePath: exe, libraryPath, version: version(exe, { ...process.env, LD_LIBRARY_PATH: libraryPath }) };
  } catch (e) {
    reasons.push(`@sparticuz/chromium: ${String(e.message).split("\n")[0]}`);
  }
  const reason = reasons.join("; ");
  return { ok: false, reason, reasons };
}

/** Applies the result to process.env so child processes (Chromium, next start, the worker) inherit it. */
export async function applyChromiumEnv() {
  const r = await ensureChromium();
  if (r.ok) {
    process.env.CHROMIUM_PATH = r.executablePath;
    if (r.libraryPath) process.env.LD_LIBRARY_PATH = r.libraryPath;
  }
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await ensureChromium();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
