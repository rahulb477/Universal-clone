import { describe, expect, it } from "vitest";
import {
  assetLocalPath,
  compilePattern,
  detectTrap,
  normalizeUrl,
  pageLocalPath,
  PathRegistry,
  relativeLink,
  sanitizeSegment,
  Scope,
  urlKey,
  type NormalizeOptions,
} from "@/lib/crawler/url";
import { DEFAULT_DENY_PARAMS, DEFAULT_STRIP_PARAMS, sanitizeOptions } from "@/lib/crawler/types";

const norm = (over: Partial<NormalizeOptions> = {}): NormalizeOptions => ({
  keepQuery: true,
  stripParams: new Set(DEFAULT_STRIP_PARAMS),
  denyParams: new Set(DEFAULT_DENY_PARAMS),
  allowParams: new Set(),
  ...over,
});

describe("normalizeUrl", () => {
  it("removes fragments, tracking params and trailing slashes; sorts params", () => {
    expect(normalizeUrl("https://a.com/about/?utm_source=x&b=2&a=1&fbclid=z#team", undefined, norm())).toBe("https://a.com/about?a=1&b=2");
    expect(normalizeUrl("https://a.com/", undefined, norm())).toBe("https://a.com/");
    expect(normalizeUrl("https://a.com//x///y/", undefined, norm())).toBe("https://a.com/x/y");
  });
  it("treats parameter order as irrelevant", () => {
    expect(normalizeUrl("/p?b=1&a=2", "https://a.com", norm())).toBe(normalizeUrl("/p?a=2&b=1", "https://a.com", norm()));
  });
  it("keeps meaningful parameters as separate pages", () => {
    const a = normalizeUrl("/products?id=123", "https://a.com", norm());
    const b = normalizeUrl("/products?id=456", "https://a.com", norm());
    expect(a).not.toBe(b);
  });
  it("drops all queries when query crawling is disabled", () => {
    expect(normalizeUrl("/?page=2", "https://a.com", norm({ keepQuery: false }))).toBe("https://a.com/");
  });
  it("rejects denied parameters, non-http schemes and garbage", () => {
    expect(normalizeUrl("/x?sessionid=1", "https://a.com", norm())).toBeNull();
    expect(normalizeUrl("mailto:a@b.c", "https://a.com", norm())).toBeNull();
    expect(normalizeUrl("javascript:void(0)", "https://a.com", norm())).toBeNull();
    expect(normalizeUrl("http://", undefined, norm())).toBeNull();
  });
  it("allow-list keeps only listed parameters", () => {
    expect(normalizeUrl("/x?page=2&color=red", "https://a.com", norm({ allowParams: new Set(["page"]) }))).toBe("https://a.com/x?page=2");
  });
  it("urlKey merges www and non-www", () => {
    expect(urlKey("https://www.a.com/x")).toBe(urlKey("https://a.com/x"));
  });
});

describe("trap detection", () => {
  it.each([
    ["https://a.com/calendar/2024/05/12", true],
    ["https://a.com/events?date=2024-05-01", true],
    ["https://a.com/calendar?month=2024-05", true],
    ["https://a.com/a/b/a/b/a/b", true],
    ["https://a.com/" + "x/".repeat(3) + "y", true],
    ["https://a.com/" + Array.from({ length: 16 }, (_, i) => "s" + i).join("/"), true],
    ["https://a.com/blog/2024/05/12/my-post", false],
    ["https://a.com/products?id=1", false],
    ["https://a.com/news?page=2", false],
  ])("%s -> trap=%s", (url, trap) => {
    expect(detectTrap(new URL(url)) !== null).toBe(trap);
  });
});

describe("local paths", () => {
  const pp = (u: string) => pageLocalPath(new URL(u), "a.com", "");
  it("maps pages to index.html files", () => {
    expect(pp("https://a.com/")).toBe("index.html");
    expect(pp("https://a.com/about")).toBe("about/index.html");
    expect(pp("https://a.com/about/")).toBe("about/index.html");
    expect(pp("https://a.com/services/web-development")).toBe("services/web-development/index.html");
    expect(pp("https://www.a.com/x.html")).toBe("x.html");
    expect(pp("https://a.com/x.php")).toBe("x.php.html");
  });
  it("encodes query strings into distinct files", () => {
    expect(pp("https://a.com/?page=2")).toBe("index__page-2.html");
    expect(pp("https://a.com/products?id=123")).toBe("products/index__id-123.html");
    expect(pp("https://a.com/products?id=1&x=2")).not.toBe(pp("https://a.com/products?id=1&x=3"));
  });
  it("puts subdomains and other ports in separate folders", () => {
    expect(pp("https://blog.a.com/x")).toBe("_sub/blog.a.com/x/index.html");
    expect(pp("https://a.com:8080/x")).toBe("_sub/a.com_8080/x/index.html");
  });
  it("never produces traversal segments or illegal characters", () => {
    const evil = [
      "https://a.com/..%2f..%2fetc/passwd",
      "https://a.com/a/%2e%2e/%2e%2e/b",
      "https://a.com/a%00b",
      "https://a.com/%5C..%5Cwin",
      "https://a.com/con",
      "https://a.com/" + "x".repeat(400),
    ];
    for (const e of evil) {
      for (const p of [pp(e), assetLocalPath(new URL(e), "a.com", "", "image/png")]) {
        expect(p.split("/")).not.toContain("..");
        expect(p).not.toMatch(/[\0\\:*?"<>|]/);
        expect(p.startsWith("/")).toBe(false);
        expect(p.split("/").every((s) => s.length <= 120)).toBe(true);
      }
    }
    expect(sanitizeSegment("..")).toBe("_");
    expect(sanitizeSegment(".htaccess")).toBe("_htaccess");
  });
  it("assets keep their structure; query and external hosts are disambiguated", () => {
    expect(assetLocalPath(new URL("https://a.com/css/main.css"), "a.com", "")).toBe("css/main.css");
    expect(assetLocalPath(new URL("https://cdn.x.com/lib/a.js"), "a.com", "")).toBe("_ext/cdn.x.com/lib/a.js");
    expect(assetLocalPath(new URL("https://a.com/s.css?v=1"), "a.com", "")).toMatch(/^s__[0-9a-f]{6}\.css$/);
    expect(assetLocalPath(new URL("https://a.com/img/x"), "a.com", "", "image/webp")).toBe("img/x.webp");
  });
  it("PathRegistry resolves collisions (case-insensitively)", () => {
    const r = new PathRegistry();
    const a = r.reserve("img/Logo.png", "k1");
    const b = r.reserve("img/logo.png", "k2");
    expect(a).toBe("img/Logo.png");
    expect(b).not.toBe(a);
    expect(b.toLowerCase()).not.toBe(a.toLowerCase());
    expect(r.reserve("img/Logo.png", "k1")).toBe(a);
  });
  it("relativeLink computes relative paths", () => {
    expect(relativeLink("index.html", "about/index.html")).toBe("about/index.html");
    expect(relativeLink("services/web/index.html", "index.html")).toBe("../../index.html");
    expect(relativeLink("a/b.html", "a/c.html")).toBe("c.html");
  });
});

describe("Scope", () => {
  const opts = { includeSubdomains: false, restrictToPathPrefix: false, includePatterns: [], excludePatterns: [] };
  it("enforces the domain boundary", () => {
    const s = new Scope(new URL("https://example.com/"), opts);
    expect(s.isSameSite(new URL("https://example.com/x"))).toBe(true);
    expect(s.isSameSite(new URL("https://www.example.com/x"))).toBe(true);
    expect(s.isSameSite(new URL("https://blog.example.com/x"))).toBe(false);
    expect(s.isSameSite(new URL("https://example.com.evil.com/x"))).toBe(false);
    expect(s.isSameSite(new URL("https://notexample.com/x"))).toBe(false);
    expect(s.isSameSite(new URL("https://example.com:8443/x"))).toBe(false);
  });
  it("subdomains only when enabled (and never lookalikes)", () => {
    const s = new Scope(new URL("https://example.com/"), { ...opts, includeSubdomains: true });
    expect(s.isSameSite(new URL("https://blog.example.com/"))).toBe(true);
    expect(s.isSameSite(new URL("https://evilexample.com/"))).toBe(false);
  });
  it("include / exclude patterns and path prefix", () => {
    const s = new Scope(new URL("https://a.com/docs/"), { ...opts, restrictToPathPrefix: true, excludePatterns: ["*/private/*", "/\\.pdf$/"], includePatterns: [] });
    expect(s.check(new URL("https://a.com/docs/a")).ok).toBe(true);
    expect(s.check(new URL("https://a.com/other")).ok).toBe(false);
    expect(s.check(new URL("https://a.com/docs/private/x")).ok).toBe(false);
    expect(s.check(new URL("https://a.com/docs/x.pdf")).ok).toBe(false);
    const inc = new Scope(new URL("https://a.com/"), { ...opts, includePatterns: ["/blog*"] });
    expect(inc.check(new URL("https://a.com/blog/x")).ok).toBe(true);
    expect(inc.check(new URL("https://a.com/about")).ok).toBe(false);
  });
  it("compilePattern survives invalid regex", () => {
    expect(() => compilePattern("/(unclosed/")).not.toThrow();
  });
});

describe("option sanitising / resource limits", () => {
  it("clamps hostile values to hard limits", () => {
    const o = sanitizeOptions({ maxPages: 1e9, concurrency: 500, maxDepth: -5, maxTotalSize: 1e15, delayMs: "abc", renderMode: "evil", retries: 1000 });
    expect(o.maxPages).toBeLessThanOrEqual(5000);
    expect(o.concurrency).toBe(8);
    expect(o.maxDepth).toBe(0);
    expect(o.maxTotalSize).toBeLessThanOrEqual(2048 * 1024 * 1024);
    expect(o.delayMs).toBe(100);
    expect(o.renderMode).toBe("fast");
    expect(o.retries).toBeLessThanOrEqual(6);
  });
  it("ignores non-array patterns and non-string entries", () => {
    const o = sanitizeOptions({ includePatterns: "x", excludePatterns: [1, "ok", ""] });
    expect(o.includePatterns).toEqual([]);
    expect(o.excludePatterns).toEqual(["ok"]);
  });
});
