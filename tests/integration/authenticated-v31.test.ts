import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthProfile } from "@/lib/crawler/auth";
import { CombinedCrawler, type AccessMatrixRow } from "@/lib/crawler/combined";
import { Crawler, type AuthHooks } from "@/lib/crawler/engine";
import type { InteractiveLogin, SessionState } from "@/lib/crawler/interactive-login";
import type { CrawlOptions, LogEvent } from "@/lib/crawler/types";
import { requireChromium } from "../helpers";
import { startAuthSite } from "../fixtures/auth-site";

/**
 * V3.1 authenticated crawling against the controlled fixture, on a real Chromium.
 * None of these tests skips: without a browser they fail with the reason (see requireChromium()).
 */

type Site = Awaited<ReturnType<typeof startAuthSite>>;
let site: Site;
const workDirs: string[] = [];

beforeEach(async () => {
  requireChromium();
  site = await startAuthSite({ rich: true });
});
afterEach(async () => {
  await site?.close();
});
afterAll(() => {
  for (const d of workDirs) fs.rmSync(d, { recursive: true, force: true });
});

const OPTS: Partial<CrawlOptions> = { renderMode: "js", useSitemap: false, respectRobots: false, concurrency: 2, maxDepth: 3, maxPages: 20, delayMs: 0, requestTimeoutMs: 10000 };

function formProfile(username: string, extra: Partial<AuthProfile> = {}): AuthProfile {
  return {
    id: `id-${username.replace(/[^a-z0-9]/gi, "")}`,
    name: username.split("@")[0],
    loginUrl: `${site.url}/login`,
    username,
    password: `pw-${username}`,
    loginButtonSelector: "#login",
    usernameSelector: 'input[name="username"]',
    passwordSelector: 'input[name="password"]',
    authenticatedSelector: ".account[data-authenticated=true]",
    method: "form",
    ...extra,
  };
}

function newWorkDir(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  workDirs.push(d);
  return d;
}

function start(profile: AuthProfile, options: Partial<CrawlOptions> = {}, hooks?: AuthHooks, interactiveLoginTimeoutMs = 60000) {
  const crawler = new Crawler(`${site.url}/dashboard`, { ...OPTS, ...options }, { workDir: newWorkDir("v31-"), allowPrivateNetworks: true, authProfile: profile, authHooks: hooks, interactiveLoginTimeoutMs });
  const logs: LogEvent[] = [];
  crawler.on("log", (l: LogEvent) => logs.push(l));
  return { crawler, logs, run: crawler.run() };
}

const nextLogin = (emitter: { once(event: string, fn: (l: InteractiveLogin) => void): unknown }) => new Promise<InteractiveLogin>((resolve) => emitter.once("interactive-login", resolve));
const text = (zip: AdmZip, name: string) => zip.readAsText(name);
const names = (zip: AdmZip) => zip.getEntries().map((e) => e.entryName);
const allText = (zip: AdmZip, prefix = "") =>
  zip
    .getEntries()
    .filter((e) => e.entryName.startsWith(prefix))
    .map((e) => e.getData().toString("latin1"))
    .join("\n");

describe("automatic login: authenticated assets", () => {
  it("downloads protected images, CSS, fonts, SVG, background, lazy and responsive images with the profile's session and rewrites every reference", async () => {
    const p = formProfile("alice@example.test");
    const { run } = start(p, { apiDiscovery: "off" });
    const result = await run;
    expect(result.status).toBe("completed");
    const zip = new AdmZip(result.zipPath!);
    const files = names(zip);
    for (const f of ["app.css", "font.woff2", "avatar.svg", "sprite.svg", "icons.svg", "hero-1x.png", "hero-2x.png", "wide.png", "narrow.png", "lazy.png", "inline-bg.png", "bg.png"]) {
      expect(files, `protected asset ${f} must be in the archive`).toContain(`private/${f}`);
    }
    // Real protected content, not a login page saved under an asset name.
    expect(text(zip, "private/avatar.svg")).toContain("avatar-of-alice@example.test");
    expect(zip.readFile("private/hero-2x.png")!.subarray(0, 8).toString("latin1")).toBe("\x89PNG\r\n\x1a\n");
    expect(text(zip, "private/app.css")).toContain("color:#123456");

    // References are rewritten to the local copies.
    const html = text(zip, "dashboard/index.html");
    expect(html).toContain('href="../private/app.css"');
    expect(html).toContain('src="../private/avatar.svg"');
    expect(html).toContain('srcset="../private/hero-1x.png 1x, ../private/hero-2x.png 2x"');
    expect(html).toContain('<source srcset="../private/wide.png"');
    expect(html).toContain('src="../private/narrow.png"');
    expect(html).toMatch(/id="lazy"[^>]*src="\.\.\/private\/lazy\.png"/);
    expect(html).toContain("url('../private/inline-bg.png')");
    expect(html).toContain('<image href="../private/sprite.svg"');
    expect(html).toContain('<use href="../private/icons.svg#star"');
    expect(html).not.toMatch(/(src|href|srcset)="\/private\//);
    const css = text(zip, "private/app.css");
    expect(css).toMatch(/url\("?bg\.png"?\)/);
    expect(css).toMatch(/url\("?font\.woff2"?\)/);
    expect(css).not.toContain("/private/");

    // The server saw these files requested with alice's session. hero-2x / narrow are never loaded by
    // the browser itself (1x display, wide viewport), so those hits can only be the crawler's cookie fetch.
    for (const f of ["hero-2x.png", "narrow.png", "bg.png", "font.woff2"]) {
      const who = site.stats.hits[`/private/${f}`] ?? [];
      expect(who, `${f} was requested`).not.toHaveLength(0);
      expect(who.every((w) => w === "alice@example.test"), `${f} requested only with the profile's session (${who.join(",")})`).toBe(true);
    }
    const manifest = JSON.parse(text(zip, "_report/assets-manifest.json"));
    const rows: { url: string; fetchedWith: string | null; status: string }[] = manifest.assets ?? manifest;
    const hero = rows.find((r) => r.url.endsWith("/private/hero-2x.png"));
    expect(hero?.fetchedWith).toBe("session");

    // Session-ending and destructive links are never followed with a signed-in profile.
    expect(site.stats.logoutHits).toBe(0);
    expect(site.stats.deleteHits).toBe(0);
    const report = JSON.parse(text(zip, "_report/crawl-report.json"));
    expect(report.skipped.some((s: { url: string; reason: string }) => s.url.endsWith("/logout") && /end the authenticated session/.test(s.reason))).toBe(true);
    expect(report.skipped.some((s: { url: string; reason: string }) => /account\/delete/.test(s.url) && /state-changing/.test(s.reason))).toBe(true);

    // The archive holds no credential material.
    const everything = allText(zip);
    expect(everything).not.toContain(p.password || "pw-alice@example.test");
    expect(everything).not.toContain("pw-alice");
    expect(everything).not.toMatch(/sid=[a-f0-9]{20}/);
  });

  it("an anonymous crawl of the same site gets none of the protected content", async () => {
    const crawler = new Crawler(`${site.url}/dashboard`, { ...OPTS, renderMode: "fast" }, { workDir: newWorkDir("v31-anon-"), allowPrivateNetworks: true });
    const result = await crawler.run();
    const body = result.zipPath ? allText(new AdmZip(result.zipPath)) : "";
    expect(body).not.toContain("avatar-of-");
    expect(body).not.toContain("Private orders");
    expect(Object.values(site.stats.hits).flat().some((w) => w !== "anon" && w !== "request")).toBe(false);
  });
});

describe("authenticated XHR / API discovery", () => {
  it("records fetch + XHR, archives redacted JSON, follows pagination with GET, allows authorised GraphQL queries and blocks every state-changing request", async () => {
    const { run } = start(formProfile("alice@example.test"), { apiDiscovery: "archive", apiFollowPagination: true, graphqlEndpoints: [`${site.url}/graphql`], maxDepth: 0 });
    const result = await run;
    expect(result.status).toBe("completed");
    const zip = new AdmZip(result.zipPath!);
    const api = JSON.parse(text(zip, "_report/api-discovery.json"));
    const eps: any[] = api.endpoints;
    const find = (method: string, suffix: string) => eps.find((e) => e.method === method && e.url.endsWith(suffix));

    const me = find("GET", "/api/me");
    expect(me).toMatchObject({ type: "fetch", kind: "json", status: 200, archived: true });
    const orders1 = find("GET", "/api/orders?page=1");
    expect(orders1).toMatchObject({ type: "xhr", kind: "json", status: 200, archived: true });

    // Pagination: explicit next links are followed with GET, same origin, bounded.
    expect(orders1.pagination.next).toMatch(/\/api\/orders\?page=2$/);
    expect(find("GET", "/api/orders?page=2")).toMatchObject({ type: "pagination", archived: true });
    expect(find("GET", "/api/orders?page=3")).toMatchObject({ type: "pagination", archived: true });
    expect(JSON.parse(text(zip, find("GET", "/api/orders?page=3").localPath)).items[0].id).toBe(31);

    // Secrets and payment data never reach the archive.
    const stored = text(zip, me.localPath);
    expect(JSON.parse(stored).displayName).toBe("User alice@example.test");
    expect(me.redactedValues).toBeGreaterThanOrEqual(2);
    const everything = allText(zip);
    expect(everything).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(everything).not.toContain("4111 1111 1111 1111");
    expect(everything).not.toContain("4111111111111111");

    // Asset referenced only from JSON ("relevant asset request") is fetched with the session.
    expect(names(zip)).toContain("private/api-avatar.png");
    expect(site.stats.hits["/private/api-avatar.png"]).toEqual(["alice@example.test"]);

    // State-changing requests: blocked in the browser, listed, never replayed.
    const track = find("POST", "/api/track");
    expect(track).toMatchObject({ blocked: true, archived: false });
    expect(site.stats.trackPosts).toBe(0);

    // GraphQL: the explicitly authorised endpoint may answer queries; the mutation is refused.
    const gql = eps.filter((e) => e.kind === "graphql");
    expect(gql.find((e) => !e.blocked)?.graphql.operationType).toBe("query");
    expect(gql.find((e) => e.blocked)?.graphql.operationType).toBe("mutation");
    expect(site.stats.graphqlQueries).toBe(1);
    expect(site.stats.graphqlMutations).toBe(0);
    expect(site.stats.loginPosts).toBe(1);
  });

  it("does not send GraphQL requests to an endpoint that was not authorised, and stores no bodies in metadata mode", async () => {
    const { run } = start(formProfile("alice@example.test"), { apiDiscovery: "metadata", maxDepth: 0 });
    const result = await run;
    const zip = new AdmZip(result.zipPath!);
    const eps: any[] = JSON.parse(text(zip, "_report/api-discovery.json")).endpoints;
    expect(site.stats.graphqlQueries).toBe(0);
    expect(site.stats.graphqlMutations).toBe(0);
    expect(eps.filter((e) => e.kind === "graphql" || /graphql/.test(e.url)).every((e) => e.blocked)).toBe(true);
    expect(eps.some((e) => e.archived)).toBe(false);
    expect(names(zip).some((n) => n.startsWith("_api/"))).toBe(false);
    expect(eps.find((e) => e.url.endsWith("/api/me"))).toMatchObject({ status: 200, contentType: "application/json" });
    // No pagination follow-ups unless enabled.
    expect(eps.some((e) => /page=2/.test(e.url))).toBe(false);
  });
});

describe("manual browser login", () => {
  it("hands the login page to the user, detects success, preserves the session for the profile and crawls with it", async () => {
    // A manual profile carries no credentials at all.
    const profile: AuthProfile = { id: "manual1", name: "Manual", loginUrl: `${site.url}/login`, username: "", password: "", authenticatedSelector: ".account[data-authenticated=true]", method: "manual" };
    const saved: SessionState[] = [];
    const { crawler, run } = start(profile, { apiDiscovery: "off" }, { saveSession: async (s) => void saved.push(s) });
    const login = await nextLogin(crawler);
    expect(login.reason).toBe("manual-login");
    expect(login.profileId).toBe("manual1");
    expect(crawler.status).toBe("paused");
    expect(crawler.authStatus).toBe("awaiting-manual-verification");
    expect(crawler.getStats().profiles?.[0]).toMatchObject({ status: "awaiting-manual-verification", loginSessionId: login.id });
    // Nothing was submitted on the user's behalf.
    expect(site.stats.loginPosts).toBe(0);

    // What the user sees: a screenshot of the isolated browser showing the login page.
    const frame = await login.frame();
    expect(frame!.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(login.info().url).toBe(`${site.url}/login`);

    // Premature "I'm done" is rejected: confirmation alone is never proof of authentication.
    const early = await login.confirm();
    expect(early.ok).toBe(false);

    // The user signs in with pointer + keyboard events, exactly as the UI forwards them.
    await login.input({ type: "click", x: 5, y: 300 });
    await login.input({ type: "key", key: "Tab" });
    await login.input({ type: "type", text: "manual-user@example.test" });
    await login.input({ type: "key", key: "Tab" });
    await login.input({ type: "type", text: "pw-manual-user@example.test" });
    await login.input({ type: "key", key: "Enter" });

    const result = await run;
    expect(login.status).toBe("authenticated");
    expect(result.status).toBe("completed");
    expect(site.stats.loginPosts).toBe(1);
    const zip = new AdmZip(result.zipPath!);
    expect(text(zip, "account/orders/index.html")).toContain("Private orders for manual-user@example.test");
    expect(text(zip, "private/avatar.svg")).toContain("avatar-of-manual-user@example.test");
    // The session was handed to the host for encrypted storage, tied to this profile.
    expect(saved).toHaveLength(1);
    expect(saved[0].cookies.some((c) => c.name === "sid")).toBe(true);
    // The typed password is nowhere in the archive.
    expect(allText(zip)).not.toContain("pw-manual-user");
  });

  it("times out and fails the crawl when the user never signs in; nothing is crawled", async () => {
    const profile: AuthProfile = { id: "manual2", name: "Manual", loginUrl: `${site.url}/login`, username: "", password: "", authenticatedSelector: ".account[data-authenticated=true]", method: "manual" };
    const { crawler, run } = start(profile, {}, undefined, 5000);
    const login = await nextLogin(crawler);
    const result = await run;
    expect(login.status).toBe("expired");
    expect(result.status).toBe("failed");
    expect(result.stats.pagesCrawled).toBe(0);
    expect(crawler.authStatus).toBe("authentication-failed");
    expect(site.activeSessions()).toHaveLength(0);
  });

  it("cancelling the sign-in ends the crawl without a session", async () => {
    const profile: AuthProfile = { id: "manual3", name: "Manual", loginUrl: `${site.url}/login`, username: "", password: "", authenticatedSelector: ".account[data-authenticated=true]", method: "manual" };
    const { crawler, run } = start(profile);
    const login = await nextLogin(crawler);
    await login.cancel();
    const result = await run;
    expect(result.status).toBe("failed");
    expect(result.stats.pagesCrawled).toBe(0);
  });
});

describe("MFA pause / resume", () => {
  it("submits the password, pauses at the verification step without answering it, and resumes after the user enters the code", async () => {
    const p = formProfile("mfa-carol@example.test", { mfaSelector: "#otp-form" });
    const { crawler, run, logs } = start(p, { apiDiscovery: "off" });
    const login = await nextLogin(crawler);
    expect(login.reason).toBe("mfa");
    expect(crawler.status).toBe("paused");
    expect(crawler.authStatus).toBe("awaiting-manual-verification");
    expect(site.stats.loginPosts).toBe(1);
    // The crawler waits; it never guesses or submits a code.
    await new Promise((r) => setTimeout(r, 2500));
    expect(site.stats.mfaPosts).toBe(0);
    expect(crawler.status).toBe("paused");
    expect(crawler.getStats().pagesCrawled).toBe(0);
    expect(login.info().url).toBe(`${site.url}/mfa`);

    // A wrong code keeps the session waiting.
    await login.input({ type: "type", text: "000000" });
    await login.input({ type: "key", key: "Enter" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(login.status).toBe("awaiting-user");
    expect(site.stats.mfaPosts).toBe(1);

    // The user enters the right code; the crawl resumes by itself.
    await login.input({ type: "click", x: 5, y: 300 });
    await login.input({ type: "key", key: "Tab" });
    await login.input({ type: "type", text: "123456" });
    await login.input({ type: "key", key: "Enter" });
    const result = await run;
    expect(result.status).toBe("completed");
    expect(site.stats.mfaPosts).toBe(2);
    expect(site.stats.loginPosts).toBe(1);
    const zip = new AdmZip(result.zipPath!);
    expect(text(zip, "dashboard/index.html")).toContain("Account mfa-carol@example.test");
    expect(logs.some((l) => /additional verification step/.test(l.message))).toBe(true);
    // Time spent waiting for the human is not billed to the crawl.
    expect(result.stats.pagesCrawled).toBeGreaterThanOrEqual(3);
  });

  it("without an MFA selector the automated login fails closed at the verification page", async () => {
    const { run, crawler } = start(formProfile("mfa-dave@example.test"), { requestTimeoutMs: 5000 });
    const result = await run;
    expect(result.status).toBe("failed");
    expect(crawler.authStatus).toBe("authentication-failed");
    expect(site.stats.mfaPosts).toBe(0);
    expect(result.stats.pagesCrawled).toBe(0);
  });
});

describe("session persistence, expiration and reauthentication", () => {
  it("restores a saved session without logging in again", async () => {
    let saved: SessionState | null = null;
    const first = start(formProfile("erin@example.test"), { apiDiscovery: "off", maxDepth: 0 }, { saveSession: async (s) => void (saved = s) });
    expect((await first.run).status).toBe("completed");
    expect(saved).not.toBeNull();
    expect(site.stats.loginPosts).toBe(1);

    // Second crawl: deliberately wrong password — it can only succeed through the restored session.
    const second = start(formProfile("erin@example.test", { password: "wrong-password" }), { apiDiscovery: "off", maxDepth: 1 }, { loadSession: async () => saved });
    const result = await second.run;
    expect(result.status).toBe("completed");
    expect(site.stats.loginPosts).toBe(1);
    expect(second.logs.some((l) => /Restored the saved browser session/.test(l.message))).toBe(true);
    expect(text(new AdmZip(result.zipPath!), "account/orders/index.html")).toContain("Private orders for erin@example.test");
  });

  it("detects that a restored session is no longer valid, discards it, pauses, and reauthenticates on resume", async () => {
    let saved: SessionState | null = null;
    const first = start(formProfile("frank@example.test"), { apiDiscovery: "off", maxDepth: 0 }, { saveSession: async (s) => void (saved = s) });
    await first.run;
    site.expireAllSessions();

    const cleared: string[] = [];
    let store: SessionState | null = saved;
    const hooks: AuthHooks = {
      loadSession: async () => store,
      saveSession: async (s) => void (store = s),
      clearSession: async (reason) => {
        cleared.push(reason);
        store = null;
      },
    };
    const second = start(formProfile("frank@example.test"), { apiDiscovery: "off", concurrency: 1 }, hooks);
    const paused = new Promise<void>((resolve) => second.crawler.on("status", (s: string) => s === "paused" && resolve()));
    await paused;
    expect(second.crawler.authStatus).toBe("session-expired");
    expect(second.crawler.getStats().stopReason).toMatch(/session expired/i);
    expect(cleared).toEqual(["expired"]);
    expect(second.crawler.getStats().pagesCrawled).toBe(0);

    const r = await second.crawler.resumeCrawl();
    expect(r.awaitingUser).toBe(false);
    const result = await second.run;
    expect(result.status).toBe("completed");
    expect(result.stats.pagesCrawled).toBeGreaterThanOrEqual(3);
    expect(site.stats.loginPosts).toBe(2);
    expect(store).not.toBeNull();
  });

  it("expires mid-crawl, keeps the interrupted page queued, and continues after reauthentication", async () => {
    site.expireNextSessionOnOrders();
    const { crawler, run } = start(formProfile("gina@example.test"), { apiDiscovery: "off", concurrency: 1 });
    await new Promise<void>((resolve) => crawler.on("status", (s: string) => s === "paused" && resolve()));
    expect(crawler.authStatus).toBe("session-expired");
    const before = crawler.getStats().pagesCrawled;
    await crawler.resumeCrawl();
    const result = await run;
    expect(result.status).toBe("completed");
    expect(result.stats.pagesCrawled).toBeGreaterThan(before);
    expect(result.stats.pagesFailed).toBe(0);
    expect(text(new AdmZip(result.zipPath!), "account/orders/index.html")).toContain("Private orders for gina@example.test");
  });

  it("a manual profile is reauthenticated by the user: resume reports that it is waiting and continues after the sign-in", async () => {
    const profile: AuthProfile = { id: "manual4", name: "Manual", loginUrl: `${site.url}/login`, username: "", password: "", authenticatedSelector: ".account[data-authenticated=true]", method: "manual" };
    const signIn = async (login: InteractiveLogin) => {
      await login.input({ type: "click", x: 5, y: 300 });
      await login.input({ type: "key", key: "Tab" });
      await login.input({ type: "type", text: "manual-hank@example.test" });
      await login.input({ type: "key", key: "Tab" });
      await login.input({ type: "type", text: "pw-manual-hank@example.test" });
      await login.input({ type: "key", key: "Enter" });
    };
    site.expireNextSessionOnOrders();
    const { crawler, run } = start(profile, { apiDiscovery: "off", concurrency: 1 });
    await signIn(await nextLogin(crawler));
    await new Promise<void>((resolve) => crawler.on("auth", (s: string) => s === "session-expired" && resolve()));
    await new Promise((r) => setTimeout(r, 200));
    expect(crawler.status).toBe("paused");

    const again = nextLogin(crawler);
    const r = await crawler.resumeCrawl();
    expect(r.awaitingUser).toBe(true);
    const relogin = await again;
    expect(relogin.reason).toBe("reauthentication");
    expect(crawler.status).toBe("paused");
    await signIn(relogin);
    const result = await run;
    expect(result.status).toBe("completed");
    expect(site.stats.loginPosts).toBe(2);
    expect(result.stats.pagesFailed).toBe(0);
  });
});

describe("combined discovery across isolated profiles", () => {
  it("merges the URL inventory, records who discovered and who can open each page, shares only public assets and keeps accounts apart", async () => {
    const profiles = [formProfile("alice@example.test"), formProfile("bob@example.test"), formProfile("admin-root@example.test")];
    const combined = new CombinedCrawler(`${site.url}/dashboard`, { ...OPTS, apiDiscovery: "off" }, { workDir: newWorkDir("v31-combined-"), allowPrivateNetworks: true, profiles });
    const result = await combined.run();
    expect(result.status).toBe("completed");
    const zip = new AdmZip(result.zipPath!);
    const matrix: AccessMatrixRow[] = JSON.parse(text(zip, "_report/access-matrix.json"));
    const row = (suffix: string) => matrix.find((r) => r.url.endsWith(suffix))!;
    const sorted = (a: string[]) => [...a].sort();

    // A page only alice links to: discovered by alice, tried by everyone, served to alice alone.
    const aliceNotes = row("/users/alice%40example.test/notes");
    expect(aliceNotes.discoveredBy).toEqual(["alice"]);
    expect(aliceNotes.accessibleBy).toEqual(["alice"]);
    expect(sorted(aliceNotes.deniedFor)).toEqual(["admin-root", "bob"]);
    const bobNotes = row("/users/bob%40example.test/notes");
    expect(bobNotes.discoveredBy).toEqual(["bob"]);
    expect(bobNotes.accessibleBy).toEqual(["bob"]);
    // The admin area is only linked from the admin's dashboard and only the admin gets in.
    const admin = row("/admin/reports");
    expect(admin.discoveredBy).toEqual(["admin-root"]);
    expect(admin.accessibleBy).toEqual(["admin-root"]);
    expect(sorted(admin.deniedFor)).toEqual(["alice", "bob"]);
    // Shared pages: found and readable by all, but personalised, so not identical.
    const orders = row("/account/orders");
    expect(sorted(orders.discoveredBy)).toEqual(["admin-root", "alice", "bob"]);
    expect(sorted(orders.accessibleBy)).toEqual(["admin-root", "alice", "bob"]);
    expect(orders.identicalAcrossProfiles).toBe(false);
    expect(Object.keys(orders.files).sort()).toEqual(["admin-root", "alice", "bob"]);

    // One folder per profile; each contains only what that account was served.
    const files = names(zip);
    expect(files).toContain("profiles/alice/users/alice@example.test/notes/index.html");
    expect(files).not.toContain("profiles/bob/users/alice@example.test/notes/index.html");
    expect(files).toContain("profiles/admin-root/admin/reports/index.html");
    expect(files.some((f) => f.startsWith("profiles/alice/admin/"))).toBe(false);
    expect(text(zip, "profiles/alice/private/avatar.svg")).toContain("avatar-of-alice@example.test");
    expect(text(zip, "profiles/bob/private/avatar.svg")).toContain("avatar-of-bob@example.test");
    const bobTree = allText(zip, "profiles/bob/");
    expect(bobTree).not.toContain("Secret notes of alice");
    expect(bobTree).not.toContain("avatar-of-alice");
    expect(bobTree).not.toContain("Private orders for alice");
    expect(bobTree).not.toContain("Admin report for");
    const aliceTree = allText(zip, "profiles/alice/");
    expect(aliceTree).not.toContain("Secret notes of bob");
    expect(aliceTree).not.toContain("Private orders for bob");
    expect(aliceTree).toContain("Secret notes of alice@example.test");

    // The server never served one user's private page to another session.
    expect(site.stats.logoutHits).toBe(0);
    expect(site.stats.loginPosts).toBe(3);

    // No duplicate downloads of public assets: one anonymous fetch, reused by the other profiles.
    const report = JSON.parse(text(zip, "_report/combined-report.json"));
    expect(report.assetSharing.publicAssets).toBe(1);
    expect(report.assetSharing.reused).toBe(2);
    expect(report.assetSharing.protectedAssets).toBeGreaterThanOrEqual(10);
    expect(report.profiles.map((p: { status: string }) => p.status)).toEqual(["completed", "completed", "completed"]);
    expect(files).toContain("profiles/alice/public/logo.png");
    expect(files).toContain("profiles/bob/public/logo.png");
    // Protected assets were fetched per profile, with that profile's own session.
    expect(new Set(site.stats.hits["/private/hero-2x.png"].filter((w) => w !== "anon"))).toEqual(new Set(["alice@example.test", "bob@example.test", "admin-root@example.test"]));

    expect(text(zip, "index.html")).toContain("Who can open what");
    expect(text(zip, "_report/access-matrix.csv").split("\n")[0]).toBe("url,discovered_by,accessible_by,denied_for,other,identical_across_profiles");
    // No credentials anywhere in the combined archive.
    expect(allText(zip)).not.toContain("pw-alice");
  });

  it("a profile whose login fails does not stop the others and contributes nothing", async () => {
    const profiles = [formProfile("alice@example.test"), formProfile("mallory@example.test", { password: "wrong" })];
    const combined = new CombinedCrawler(`${site.url}/dashboard`, { ...OPTS, apiDiscovery: "off", maxDepth: 1, requestTimeoutMs: 5000 }, { workDir: newWorkDir("v31-combined-fail-"), allowPrivateNetworks: true, profiles });
    const result = await combined.run();
    expect(result.status).toBe("completed");
    const zip = new AdmZip(result.zipPath!);
    const report = JSON.parse(text(zip, "_report/combined-report.json"));
    expect(report.profiles.find((p: { name: string }) => p.name === "mallory").status).toBe("failed");
    expect(report.profiles.find((p: { name: string }) => p.name === "alice").status).toBe("completed");
    expect(names(zip).some((f) => f.startsWith("profiles/mallory/"))).toBe(false);
    expect(names(zip)).toContain("profiles/alice/dashboard/index.html");
  });
});
