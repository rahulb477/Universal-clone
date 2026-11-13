// The worker uses the Chromium headless shell shipped by @sparticuz/chromium. Its
// archive is a production dependency, so it survives a production-only install and
// does not depend on a build user's Playwright cache being copied into the image.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { createBrotliDecompress } from "node:zlib";
import { pipeline } from "node:stream/promises";

const require = createRequire(import.meta.url);
let resolved;

async function unpackArchive(archive, destination) {
  // Never restore archive ownership or modes. In particular tar-fs' default chown
  // fails in restricted containers, even when the files belong to the current user.
  const tar = spawn("tar", ["xf", "-", "--no-same-owner", "--no-same-permissions", "-C", destination], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  tar.stderr.on("data", chunk => { stderr += chunk; });
  const finished = new Promise((resolve, reject) => {
    tar.on("error", reject);
    tar.on("close", code => code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr}`)));
  });
  await Promise.all([pipeline(fs.createReadStream(archive), createBrotliDecompress(), tar.stdin), finished]);
}

function validate(executablePath, env) {
  fs.accessSync(executablePath, fs.constants.R_OK | fs.constants.X_OK);
  if (process.platform === "linux") {
    const libs = execFileSync("ldd", [executablePath], { env, encoding: "utf8", timeout: 30000 });
    if (/not found/.test(libs)) throw new Error(`Chromium shared libraries missing:\n${libs}`);
  }
  return execFileSync(executablePath, ["--version"], { env, encoding: "utf8", timeout: 30000 }).trim();
}

async function resolveChromium() {
  let dir;
  try {
    // An explicit operator-supplied path is an override, never a fallback.
    if (process.env.CHROMIUM_PATH) {
      return { ok: true, source: "CHROMIUM_PATH", executablePath: process.env.CHROMIUM_PATH, libraryPath: process.env.LD_LIBRARY_PATH || "", version: validate(process.env.CHROMIUM_PATH, process.env) };
    }
    if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The packaged Chromium requires Linux x64; set CHROMIUM_PATH explicitly on other platforms.");
    const bin = path.join(path.dirname(require.resolve("@sparticuz/chromium")), "..", "bin");
    // A fresh private directory prevents stale/incomplete binaries and shared /tmp
    // ownership collisions. Nothing is written to the immutable application image.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-chromium-"));
    const executablePath = path.join(dir, "chromium");
    await pipeline(fs.createReadStream(path.join(bin, "chromium.br")), createBrotliDecompress(), fs.createWriteStream(executablePath, { mode: 0o700 }));
    fs.chmodSync(executablePath, 0o700);
    await unpackArchive(path.join(bin, "fonts.tar.br"), dir);
    await unpackArchive(path.join(bin, "al2023.tar.br"), dir);
    await unpackArchive(path.join(bin, "swiftshader.tar.br"), dir);
    const fontDir = path.join(dir, "fonts");
    fs.accessSync(path.join(fontDir, "Open_Sans", "OpenSans-Regular.ttf"), fs.constants.R_OK);
    // Use the bundled fonts without relying on /tmp/fonts or a system font setup.
    const xmlPath = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    fs.writeFileSync(path.join(dir, "fonts.conf"), `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${xmlPath(fontDir)}</dir><cachedir>${xmlPath(path.join(dir, "font-cache"))}</cachedir></fontconfig>`);
    const libraryPath = [path.join(dir, "lib"), dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    const env = { ...process.env, LD_LIBRARY_PATH: libraryPath, FONTCONFIG_PATH: dir, FONTCONFIG_FILE: path.join(dir, "fonts.conf") };
    const version = validate(executablePath, env);
    const cleanupDir = dir;
    process.once("exit", () => { try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch {} });
    return { ok: true, source: "@sparticuz/chromium", executablePath, libraryPath, fontconfigPath: dir, fontconfigFile: env.FONTCONFIG_FILE, version };
  } catch (error) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason, reasons: [reason] };
  }
}

export function ensureChromium() {
  return resolved ??= resolveChromium();
}

export async function applyChromiumEnv() {
  const r = await ensureChromium();
  if (r.ok) {
    process.env.CHROMIUM_PATH = r.executablePath;
    if (r.libraryPath) process.env.LD_LIBRARY_PATH = r.libraryPath;
    if (r.fontconfigPath) process.env.FONTCONFIG_PATH = r.fontconfigPath;
    if (r.fontconfigFile) process.env.FONTCONFIG_FILE = r.fontconfigFile;
  }
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await ensureChromium();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
