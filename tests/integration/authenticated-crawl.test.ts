import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crawler } from "@/lib/crawler/engine";
import { requireChromium } from "../helpers";
import type { AuthProfile } from "@/lib/crawler/auth";
import { startAuthSite } from "../fixtures/auth-site";

let site: Awaited<ReturnType<typeof startAuthSite>>;
const workDirs: string[] = [];

beforeAll(async () => {
  site = await startAuthSite();
});
afterAll(async () => {
  await site?.close();
  for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function profile(username: string, password = `pw-${username}`): AuthProfile {
  return {
    id: username, name: `Profile ${username}`, loginUrl: `${site.url}/login`, username, password,
    loginButtonSelector: "#login", usernameSelector: 'input[name="username"]', passwordSelector: 'input[name="password"]',
    authenticatedSelector: ".account[data-authenticated=true]", method: "form",
  };
}

async function crawlAs(p: AuthProfile) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-crawl-"));
  workDirs.push(workDir);
  const crawler = new Crawler(`${site.url}/dashboard`, { renderMode: "js", useSitemap: false, respectRobots: false, maxDepth: 3, maxPages: 10, delayMs: 0, requestTimeoutMs: 10000 }, { workDir, allowPrivateNetworks: true, authProfile: p });
  const logs: string[] = [];
  crawler.on("log", (e) => logs.push(e.message));
  const result = await crawler.run();
  return { result, logs };
}

describe("authenticated isolated crawling against a local controlled site", () => {
  const browserIt = (title: string, test: () => Promise<void>) => it(title, async () => { requireChromium(); await test(); });

  browserIt("logs in, verifies state, and discovers nested authenticated GET pages", async () => {
    const p = profile("alice@example.test");
    const username = p.username;
    const password = p.password;
    const { result, logs } = await crawlAs(p);
    expect(result.status).toBe("completed");
    expect(result.stats.pagesCrawled).toBe(3);
    const zip = new AdmZip(result.zipPath!);
    const contents = zip.getEntries().map((e) => e.getData().toString("utf8")).join("\n");
    expect(contents).toContain("Account alice@example.test");
    expect(contents).toContain("Private orders for alice@example.test");
    expect(contents).toContain("Settings for alice@example.test");
    expect(contents).not.toContain(password);
    expect(logs.join("\n")).not.toContain(password);
    expect(logs.join("\n")).not.toContain(username);
  });

  browserIt("keeps two profiles' cookies and downloaded pages separate", async () => {
    const alice = profile("alice@example.test");
    const bob = profile("bob@example.test");
    const [a, b] = await Promise.all([crawlAs(alice), crawlAs(bob)]);
    expect(a.result.status).toBe("completed");
    expect(b.result.status).toBe("completed");
    const aZip = new AdmZip(a.result.zipPath!).getEntries().map((e) => e.getData().toString("utf8")).join("\n");
    const bZip = new AdmZip(b.result.zipPath!).getEntries().map((e) => e.getData().toString("utf8")).join("\n");
    expect(aZip).toContain("alice@example.test");
    expect(aZip).not.toContain("bob@example.test");
    expect(bZip).toContain("bob@example.test");
    expect(bZip).not.toContain("alice@example.test");
  });

  browserIt("pauses on session expiration and reauthenticates before restoring the queued page", async () => {
    site.expireNextSessionOnOrders();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-resume-"));
    workDirs.push(workDir);
    const crawler = new Crawler(`${site.url}/dashboard`, { renderMode: "js", useSitemap: false, respectRobots: false, concurrency: 1, maxDepth: 3, maxPages: 10, delayMs: 0, requestTimeoutMs: 10000 }, { workDir, allowPrivateNetworks: true, authProfile: profile("recover@example.test") });
    const paused = new Promise<void>((resolve) => crawler.on("status", (status) => { if (status === "paused") resolve(); }));
    const run = crawler.run();
    await paused;
    expect(crawler.getStats().status).toBe("paused");
    await crawler.resumeCrawl();
    const result = await run;
    expect(result.status).toBe("completed");
    expect(result.stats.pagesCrawled).toBe(3);
  });

  browserIt("does not treat invalid credentials as authentication success", async () => {
    const { result } = await crawlAs(profile("alice@example.test", "wrong"));
    expect(result.status).toBe("failed");
    expect(result.stats.pagesCrawled).toBe(0);
  });
});
