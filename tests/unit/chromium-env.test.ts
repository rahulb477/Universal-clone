import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function isolatedEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uc-browser-test-"));
  dirs.push(tmp);
  // A pre-existing /tmp/fonts must never be touched by extraction.
  fs.mkdirSync(path.join(tmp, "fonts"), { mode: 0o500 });
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
  delete env.CHROMIUM_PATH;
  delete env.FONTCONFIG_PATH;
  delete env.FONTCONFIG_FILE;
  delete env.LD_LIBRARY_PATH;
  return { env, tmp };
}

describe("packaged Chromium", () => {
  it("extracts privately, checks fonts and shared libraries, and launches a real page", () => {
    const { env, tmp } = isolatedEnv();
    const script = `
      import { applyChromiumEnv } from './scripts/chromium-env.mjs';
      import { chromium } from 'playwright-core';
      import fs from 'node:fs';
      const r = await applyChromiumEnv();
      if (!r.ok) throw Error(r.reason);
      fs.accessSync(r.executablePath, fs.constants.X_OK);
      if (!fs.readFileSync(r.fontconfigFile, 'utf8').includes(r.fontconfigPath + '/fonts')) throw Error('fonts missing');
      const b = await chromium.launch({executablePath:r.executablePath,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
      const p = await b.newPage(); await p.setContent('<p>ready</p>');
      if (await p.textContent('p') !== 'ready') throw Error('page failed');
      await b.close(); console.log(JSON.stringify(r));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env, encoding: "utf8", timeout: 60000 });
    const result = JSON.parse(output);
    expect(result.source).toBe("@sparticuz/chromium");
    expect(result.executablePath.startsWith(path.join(tmp, "uc-chromium-"))).toBe(true);
    expect(fs.existsSync(result.executablePath)).toBe(false); // cleaned up on normal exit
    expect(fs.readdirSync(path.join(tmp, "fonts"))).toEqual([]);
  }, 90000);

  it("does not silently fall back when an explicit binary is invalid", () => {
    const { env } = isolatedEnv();
    env.CHROMIUM_PATH = "/does/not/exist/chromium";
    const result = spawnSync(process.execPath, ["scripts/chromium-env.mjs"], { env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("/does/not/exist/chromium");
    expect(result.stdout).not.toContain('"source":');
  });
});
