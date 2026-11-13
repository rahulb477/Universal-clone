import crypto from "node:crypto";
import { hostMatchesAddress } from "@/lib/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertLoginUrlInScope,
  hostKey,
  hostMatchesScope,
  normalizeAddress,
  openSession,
  parseRequestCapture,
  SavedProfileError,
  scopeSessionState,
  sealSession,
  sessionAad,
  sessionFingerprint,
  validateProfileInput,
} from "@/lib/crawler/saved-login";
import { decryptSecret, encryptSecret } from "@/lib/crawler/auth";
import type { SessionState } from "@/lib/crawler/interactive-login";
import { parseLoginInput } from "@/lib/crawler/interactive-login";

/**
 * Pure rules of the reusable "Login with Browser" profiles: URL validation, the domain pinning that
 * keeps one site's cookies away from another, the encrypted session envelope, and the redaction
 * guarantees of the request-login fallback.
 */

const KEY = Buffer.alloc(32, 9).toString("base64");
const saved: Array<[string, string | undefined]> = [];
const setEnv = (k: string, v: string) => {
  saved.push([k, process.env[k]]);
  process.env[k] = v;
};

beforeEach(() => {
  setEnv("CRAWLER_CREDENTIAL_ENCRYPTION_KEY", KEY);
});
afterEach(() => {
  for (const [k, v] of saved.splice(0)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const state = (cookies: Array<{ name: string; domain: string; value?: string }> = [{ name: "sid", domain: "app.example.com" }], origins: string[] = ["https://app.example.com"]): SessionState =>
  ({
    cookies: cookies.map((c) => ({ name: c.name, value: c.value ?? "s3cret-" + c.name, domain: c.domain, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" })),
    origins: origins.map((origin) => ({ origin, localStorage: [{ name: "token", value: "abc" }] })),
  }) as unknown as SessionState;

describe("website address validation", () => {
  it("accepts a bare host and adds https", () => {
    expect(normalizeAddress("example.com").href).toBe("https://example.com/");
    expect(normalizeAddress("  https://app.example.com/login?next=/  ").href).toBe("https://app.example.com/login?next=/");
  });

  it("rejects anything that is not a plain http(s) address", () => {
    for (const bad of ["", "   ", "ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com/"]) {
      expect(() => normalizeAddress(bad), bad).toThrow(SavedProfileError);
    }
    expect(() => normalizeAddress(123 as unknown)).toThrow(/Enter a/);
    expect(() => normalizeAddress("https://example.com/" + "a".repeat(3000))).toThrow(/too long/);
  });

  it("keys a host with its non-default port, and drops default ports", () => {
    expect(hostKey(new URL("https://example.com:8443/x"))).toBe("example.com:8443");
    expect(hostKey(new URL("https://example.com:443/x"))).toBe("example.com");
    expect(hostKey(new URL("http://example.com:80/x"))).toBe("example.com");
  });

  it("validates the profile body", () => {
    expect(validateProfileInput({ name: " Work ", startUrl: "app.example.com", loginUrl: "https://app.example.com/login", matchSubdomains: true })).toEqual({
      name: "Work",
      startUrl: "https://app.example.com/",
      loginUrl: "https://app.example.com/login",
      matchSubdomains: true,
    });
    expect(() => validateProfileInput({ startUrl: "example.com" })).toThrow(/name/);
    expect(() => validateProfileInput({ name: "x" })).toThrow(/website address/);
    expect(() => validateProfileInput({ name: "x", startUrl: "example.com", matchSubdomains: "yes" as unknown as boolean })).toThrow(/true or false/);
    expect(() => validateProfileInput({ name: "a".repeat(81), startUrl: "example.com" })).toThrow(/too long/);
  });

  it("keeps the sign-in page inside the profile's site", () => {
    expect(() => assertLoginUrlInScope("https://example.com/", "https://other.example/login", false)).toThrow(/must be on example\.com/);
    expect(() => assertLoginUrlInScope("https://example.com/", "https://example.com.attacker.test/login", false)).toThrow();
    expect(() => assertLoginUrlInScope("https://example.com/", "https://app.example.com/login", false)).toThrow();
    expect(() => assertLoginUrlInScope("https://example.com/", "https://app.example.com/login", true)).not.toThrow();
    expect(() => assertLoginUrlInScope("https://example.com/", null, false)).not.toThrow();
  });
});

describe("profile-to-domain association", () => {
  const scope = { targetHost: "example.com", matchSubdomains: false };

  it("matches exactly the saved host by default", () => {
    expect(hostMatchesScope(scope, "https://example.com/")).toBe(true);
    expect(hostMatchesScope(scope, "http://example.com:80/x")).toBe(true);
    expect(hostMatchesScope(scope, "https://app.example.com/")).toBe(false);
    // Look-alike domains never match: this is not a substring test.
    expect(hostMatchesScope(scope, "https://evil-example.com/")).toBe(false);
    expect(hostMatchesScope(scope, "https://example.com.attacker.test/")).toBe(false);
    expect(hostMatchesScope(scope, "https://example.co/")).toBe(false);
    expect(hostMatchesScope(scope, "example.com:8443")).toBe(false);
  });

  it("matches subdomains only when the profile asked for it, and never for IP addresses", () => {
    const sub = { targetHost: "example.com", matchSubdomains: true };
    expect(hostMatchesScope(sub, "https://app.example.com/")).toBe(true);
    expect(hostMatchesScope(sub, "https://a.b.example.com/")).toBe(true);
    expect(hostMatchesScope(sub, "https://example.com/")).toBe(true);
    expect(hostMatchesScope(sub, "https://notexample.com/")).toBe(false);
    expect(hostMatchesScope(sub, "https://example.com.evil.test/")).toBe(false);
    const ip = { targetHost: "10.1.2.3", matchSubdomains: true };
    expect(hostMatchesScope(ip, "http://10.1.2.3/")).toBe(true);
    expect(hostMatchesScope(ip, "http://x.10.1.2.3/")).toBe(false);
  });
});

describe("session isolation between sites", () => {
  const scope = { targetHost: "app.example.com", targetOrigin: "https://app.example.com", matchSubdomains: false };

  it("keeps only the profile's own cookies and storage", () => {
    const scoped = scopeSessionState(
      scope,
      state(
        [
          { name: "sid", domain: "app.example.com" },
          { name: "parent", domain: ".example.com" },
          { name: "sso", domain: "login.identity-provider.test" },
          { name: "analytics", domain: ".google-analytics.com" },
          { name: "lookalike", domain: "app.example.com.evil.test" },
        ],
        ["https://app.example.com", "https://login.identity-provider.test", "https://other.example.com"],
      ),
    );
    expect(scoped.cookies.map((c) => c.name)).toEqual(["sid", "parent"]);
    expect(scoped.origins.map((o) => o.origin)).toEqual(["https://app.example.com"]);
  });

  it("keeps a cookie set on a parent domain, because the browser sends it to the target as well", () => {
    const base = { targetHost: "app.example.com", targetOrigin: "https://app.example.com", matchSubdomains: false };
    const s = state([{ name: "shell", domain: ".example.com" }], []);
    expect(scopeSessionState(base, s).cookies.map((c) => c.name)).toEqual(["shell"]);
    expect(scopeSessionState({ ...base, matchSubdomains: true }, s).cookies.map((c) => c.name)).toEqual(["shell"]);
  });

  it("drops cookies of a sub-domain when the profile is limited to its exact host", () => {
    const base = { targetHost: "example.com", targetOrigin: "https://example.com", matchSubdomains: false };
    const s = state([{ name: "app-only", domain: "app.example.com" }, { name: "sibling", domain: "admin.example.com" }], []);
    expect(scopeSessionState(base, s).cookies).toHaveLength(0);
    expect(scopeSessionState({ ...base, matchSubdomains: true }, s).cookies.map((c) => c.name)).toEqual(["app-only", "sibling"]);
  });
});

describe("encrypted session at rest", () => {
  const s = state();

  it("round-trips and never stores the cookie value in the clear", () => {
    const sealed = sealSession("0123456789abcdef", "owner-1", "app.example.com", s);
    expect(sealed.envelope).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed.envelope).not.toContain("sid");
    expect(sealed.envelope).not.toContain("s3cret-sid");
    expect(sealed).toMatchObject({ cookieCount: 1, originCount: 1 });
    expect(sessionFingerprint(openSession("0123456789abcdef", "owner-1", "app.example.com", sealed.envelope))).toBe(sessionFingerprint(s));
  });

  it("refuses a ciphertext moved to another profile, owner or site", () => {
    const sealed = sealSession("0123456789abcdef", "owner-1", "app.example.com", s).envelope;
    expect(() => openSession("ffffffffffffffff", "owner-1", "app.example.com", sealed)).toThrow();
    expect(() => openSession("0123456789abcdef", "owner-2", "app.example.com", sealed)).toThrow();
    // The important one: the same row cannot be replayed against another site.
    expect(() => openSession("0123456789abcdef", "owner-1", "evil.test", sealed)).toThrow();
    expect(() => openSession("0123456789abcdef", "owner-1", "APP.example.com", sealed)).not.toThrow();
  });

  it("binds the additional data to the three values", () => {
    expect(sessionAad("p", "o", "Example.COM")).toBe("saved-session:p:o:example.com");
    expect(sessionAad("p", "o", "example.com")).not.toBe(sessionAad("p", "o", "example.org"));
  });

  it("uses a random IV, so the same state encrypts differently every time", () => {
    const a = sealSession("0123456789abcdef", "o", "app.example.com", s).envelope;
    const b = sealSession("0123456789abcdef", "o", "app.example.com", s).envelope;
    expect(a).not.toBe(b);
    expect(openSession("0123456789abcdef", "o", "app.example.com", a)).toEqual(openSession("0123456789abcdef", "o", "app.example.com", b));
  });

  it("needs the configured key: without it nothing can be encrypted or decrypted", () => {
    const sealed = sealSession("0123456789abcdef", "o", "app.example.com", s).envelope;
    delete process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => openSession("0123456789abcdef", "o", "app.example.com", sealed)).toThrow(/CRAWLER_CREDENTIAL_ENCRYPTION_KEY/);
    process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    // A rotated key makes old sessions unreadable rather than silently wrong.
    expect(() => openSession("0123456789abcdef", "o", "app.example.com", sealed)).toThrow();
  });
});

describe("request-login (-d) fallback", () => {
  const scope = { targetHost: "app.example.com", targetOrigin: "https://app.example.com", matchSubdomains: false };
  const curl = `curl 'https://app.example.com/dashboard' \\
  -H 'accept: text/html' \\
  -H 'cookie: sid=abc123; theme=dark; __Host-csrf=zzz' \\
  -H 'authorization: Bearer super-secret-token' \\
  --compressed`;

  it("turns a copied cURL command into a site-scoped session", () => {
    const r = parseRequestCapture(curl, scope);
    expect(r.cookieCount).toBe(3);
    expect(r.hosts).toEqual(["app.example.com"]);
    expect(r.state.cookies.map((c) => c.name).sort()).toEqual(["__Host-csrf", "sid", "theme"]);
    expect(r.state.cookies.every((c) => c.domain === "app.example.com" && c.secure)).toBe(true);
    expect(r.state.origins).toEqual([]);
    // …and the imported session is still only usable for this site.
    const scoped = scopeSessionState(scope, r.state);
    expect(scoped.cookies).toHaveLength(3);
    expect(scopeSessionState({ ...scope, targetHost: "evil.test" }, r.state).cookies).toHaveLength(0);
  });

  it("never keeps the authorization header, and reports only header names", () => {
    const r = parseRequestCapture(curl, scope);
    expect(r.headerNames).toContain("accept");
    expect(r.headerNames).not.toContain("cookie");
    expect(r.headerNames).not.toContain("authorization");
    expect(JSON.stringify(r)).not.toContain("super-secret-token");
  });

  it("accepts a bare Cookie header and a wget command", () => {
    const header = parseRequestCapture("Cookie: sid=xyz; a=b", scope);
    expect(header.cookieCount).toBe(2);
    expect(header.state.cookies.every((c) => !c.value.match(/sid=/))).toBe(true);
    const wget = parseRequestCapture("wget 'https://app.example.com/' --header='cookie: sid=q1' --header='x-requested-with: XMLHttpRequest'", scope);
    expect(wget.cookieCount).toBe(1);
    expect(wget.headerNames).toEqual(["x-requested-with"]);
  });

  it("rejects input without cookies and oversized input", () => {
    expect(() => parseRequestCapture("curl https://app.example.com/", scope)).toThrow(/No cookies/);
    expect(() => parseRequestCapture("", scope)).toThrow(/Paste/);
    expect(() => parseRequestCapture(42 as unknown, scope)).toThrow(/Paste/);
    expect(() => parseRequestCapture("x".repeat(70 * 1024), scope)).toThrow(/too large/);
  });
});

describe("login window input validation (redaction boundary)", () => {
  it("accepts pointer, text, key and navigation events inside the viewport only", () => {
    expect(parseLoginInput({ type: "click", x: 10, y: 20 })).toEqual({ type: "click", x: 10, y: 20 });
    expect(parseLoginInput({ type: "type", text: "hunter2" })).toEqual({ type: "type", text: "hunter2" });
    expect(parseLoginInput({ type: "key", key: "Enter" })).toEqual({ type: "key", key: "Enter" });
    expect(() => parseLoginInput({ type: "click", x: 5000, y: 0 })).toThrow();
    expect(() => parseLoginInput({ type: "key", key: "F12" })).toThrow();
    expect(() => parseLoginInput({ type: "type", text: "x".repeat(501) })).toThrow();
    expect(() => parseLoginInput({ type: "exec" })).toThrow();
  });

  it("keeps typed text out of error messages", () => {
    const secret = "correct-horse-battery";
    try {
      parseLoginInput({ type: "type", text: secret.repeat(60) });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
    const envelope = encryptSecret(JSON.stringify({ text: secret }), "cmd:login-browser:abc");
    expect(envelope).not.toContain(secret);
    expect(decryptSecret(envelope, "cmd:login-browser:abc")).toContain(secret);
    expect(() => decryptSecret(envelope, "cmd:login-browser:other")).toThrow();
  });
});

describe("the browser's idea of “this login belongs to this address”", () => {
  // The panel and the API must agree, including on ports: every fixture site runs on its own port,
  // so a host-only comparison would offer another site's login for a different site.
  it("matches the exact host and port, never another site on the same hostname", () => {
    expect(hostMatchesAddress("example.com", false, "https://example.com/dashboard")).toBe(true);
    expect(hostMatchesAddress("example.com:8443", false, "https://example.com:8443/x")).toBe(true);
    expect(hostMatchesAddress("example.com:8443", false, "https://example.com/x")).toBe(false);
    expect(hostMatchesAddress("127.0.0.1:4000", false, "http://127.0.0.1:4001/dashboard")).toBe(false);
    expect(hostMatchesAddress("127.0.0.1:4000", false, "http://127.0.0.1:4000/dashboard")).toBe(true);
  });

  it("accepts subdomains only when the profile allows them, and never strings that merely end the same", () => {
    expect(hostMatchesAddress("example.com", true, "https://app.example.com/x")).toBe(true);
    expect(hostMatchesAddress("example.com", false, "https://app.example.com/x")).toBe(false);
    expect(hostMatchesAddress("example.com", true, "https://notexample.com/x")).toBe(false);
    expect(hostMatchesAddress("example.com", true, "https://example.com.evil.test/x")).toBe(false);
    expect(hostMatchesAddress("127.0.0.1:4000", true, "http://sub.127.0.0.1:4000/x")).toBe(false);
    expect(hostMatchesAddress("example.com", false, "not a url")).toBe(false);
  });
});
