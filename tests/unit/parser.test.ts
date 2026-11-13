import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { decodeHtml, extractCssRefs, extractFromHtml, extractJsAssetUrls, parseSrcset, rewriteCss, rewriteHtml } from "@/lib/crawler/parser";
import { Robots, parseSitemap } from "@/lib/crawler/robots";
import { compareImages, verdictFor } from "@/lib/crawler/visual";

describe("srcset / css", () => {
  it("parses srcset candidates", () => {
    expect(parseSrcset("a.jpg 480w, b.jpg 960w").map((c) => c.url)).toEqual(["a.jpg", "b.jpg"]);
    expect(parseSrcset("a.jpg 1x,b.jpg 2x").map((c) => c.url)).toEqual(["a.jpg", "b.jpg"]);
    expect(parseSrcset("only.jpg").map((c) => c.url)).toEqual(["only.jpg"]);
  });
  it("extracts url() and @import references, skipping data URIs", () => {
    const css = `@import "a.css"; @import url('b.css'); .x{background:url(img/c.png)} .y{background:url("d.png?v=1")} .z{background:url(data:image/png;base64,AAAA)} .f{src:url(../f.woff2) format("woff2")}`;
    const refs = extractCssRefs(css, "https://a.com/css/main.css");
    expect(refs).toEqual(
      expect.arrayContaining([
        "https://a.com/css/a.css",
        "https://a.com/css/b.css",
        "https://a.com/css/img/c.png",
        "https://a.com/css/d.png?v=1",
        "https://a.com/f.woff2",
      ]),
    );
    expect(refs.some((r) => r.startsWith("data:"))).toBe(false);
  });
  it("rewrites css references", () => {
    const out = rewriteCss(`@import "a.css"; .x{background:url(c.png)} .d{background:url(data:x)}`, (raw) => "L/" + raw);
    expect(out).toContain('@import "L/a.css"');
    expect(out).toContain('url("L/c.png")');
    expect(out).toContain("url(data:x)");
  });
  it("finds asset URLs inside JavaScript strings", () => {
    const js = `var a="/img/a.png"; var b='https://cdn.x.com/f/b.woff2?v=2'; var c="/not/an/asset"; var d="//cdn.y.com/z.svg"`;
    expect(extractJsAssetUrls(js, "https://a.com/js/app.js")).toEqual(["https://a.com/img/a.png", "https://cdn.x.com/f/b.woff2?v=2", "https://cdn.y.com/z.svg"]);
  });
});

const HTML = `<!DOCTYPE html><html><head><meta charset="iso-8859-1"><title> T </title><link rel="canonical" href="/canon"><link rel="stylesheet" href="/s.css" integrity="sha384-x" crossorigin>
<link rel="icon" href="/fav.ico"><link rel="next" href="/p2"><link rel="alternate" hreflang="de" href="/de/"><meta property="og:image" content="/og.png"><base href="/sub/">
<style>.a{background:url(bg.png)}</style></head><body style="background:url('/body.png')">
<a href="a">rel</a><a href="/abs#frag">abs</a><a href="https://ext.com/x">ext</a><a href="mailto:x@y.z">m</a><a href="javascript:void(0)">j</a><a href="#top">top</a><a href="/files/doc.pdf">doc</a>
<img src="data:image/gif;base64,AAA" data-src="/lazy.png"><img src="/i.png" srcset="/i1.png 1x, /i2.png 2x"><video poster="/poster.jpg"><source src="/v.mp4"></video>
<script src="/app.js"></script><script>var x="/img/inline.png"</script><form method="post" action="/submit"></form><iframe src="https://yt.com/embed"></iframe></body></html>`;

describe("html extraction", () => {
  const ex = extractFromHtml(HTML, "https://a.com/page");
  it("separates pages, assets, docs and canonical; honours <base>", () => {
    expect(ex.title).toBe("T");
    expect(ex.canonical).toBe("https://a.com/canon");
    expect(ex.links).toEqual(expect.arrayContaining(["https://a.com/sub/a", "https://a.com/abs#frag", "https://ext.com/x", "https://a.com/p2", "https://a.com/de/"]));
    expect(ex.links.some((l) => l.startsWith("mailto") || l.startsWith("javascript"))).toBe(false);
    expect(ex.links).not.toContain("https://a.com/files/doc.pdf");
    expect(ex.docs).toEqual(["https://a.com/files/doc.pdf"]);
  });
  it("finds every kind of asset reference", () => {
    for (const a of [
      "https://a.com/s.css",
      "https://a.com/fav.ico",
      "https://a.com/og.png",
      "https://a.com/lazy.png",
      "https://a.com/i1.png",
      "https://a.com/i2.png",
      "https://a.com/poster.jpg",
      "https://a.com/v.mp4",
      "https://a.com/app.js",
      "https://a.com/sub/bg.png",
      "https://a.com/body.png",
    ]) {
      expect(ex.assets).toContain(a);
    }
    expect(ex.jsAssets).toContain("https://a.com/img/inline.png");
    expect(ex.forms).toEqual([{ action: "/submit", method: "post" }]);
    expect(ex.embeds).toEqual(["https://yt.com/embed"]);
  });
});

describe("html rewriting", () => {
  const out = rewriteHtml(
    HTML,
    "https://a.com/page",
    (abs, kind) => {
      if (kind === "canonical" || kind === "discover") return null;
      if (abs.startsWith("https://ext.com")) return null;
      return "LOCAL(" + abs.replace("https://a.com", "") + ")";
    },
    (raw) => "CSS(" + raw + ")",
    { stripScripts: false, banner: "test" },
  );
  it("rewrites internal references only", () => {
    expect(out).toContain('href="LOCAL(/sub/a)"');
    expect(out).toContain('href="LOCAL(/abs#frag)"');
    expect(out).toContain('href="https://ext.com/x"');
    expect(out).toContain('href="mailto:x@y.z"');
    expect(out).toContain('src="LOCAL(/app.js)"');
    expect(out).toContain('srcset="LOCAL(/i1.png) 1x, LOCAL(/i2.png) 2x"');
    expect(out).toContain('poster="LOCAL(/poster.jpg)"');
    expect(out).toContain('content="LOCAL(/og.png)"');
    expect(out).toContain('url("CSS(bg.png)")');
    expect(out).toContain("url(&apos;CSS(/body.png)&apos;)".replace(/&apos;/g, "'"));
  });
  it("promotes lazy-load sources, drops integrity, base and old charset", () => {
    expect(out).toContain('src="LOCAL(/lazy.png)"');
    expect(out).not.toContain("integrity");
    expect(out).not.toContain("<base");
    expect(out).not.toContain("iso-8859-1");
    expect(out).toContain('<meta charset="utf-8">');
  });
  it("can strip scripts for rendered snapshots", () => {
    const stripped = rewriteHtml(HTML, "https://a.com/page", () => null, () => null, { stripScripts: true });
    expect(stripped).not.toContain("<script");
  });
  it("decodes legacy charsets", () => {
    expect(decodeHtml(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "text/html; charset=iso-8859-1")).toBe("café");
    expect(decodeHtml(Buffer.from("café"), "text/html")).toBe("café");
  });
});

describe("robots.txt and sitemaps", () => {
  const robots = Robots.parse(`User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nCrawl-delay: 2\nSitemap: https://a.com/sm.xml\n\nUser-agent: badbot\nDisallow: /\n`);
  it("applies longest-match rules, wildcards and crawl-delay", () => {
    expect(robots.allowed("/")).toBe(true);
    expect(robots.allowed("/private/x")).toBe(false);
    expect(robots.allowed("/private/public/x")).toBe(true);
    expect(robots.allowed("/doc.pdf")).toBe(false);
    expect(robots.allowed("/doc.pdf?x=1")).toBe(true);
    expect(robots.crawlDelayMs).toBe(2000);
    expect(robots.sitemaps).toEqual(["https://a.com/sm.xml"]);
  });
  it("prefers a group that names our bot", () => {
    const current = Robots.parse("User-agent: *\nDisallow:\n\nUser-agent: UniversalCloneBot\nDisallow: /x\n");
    expect(current.allowed("/x")).toBe(false);
    expect(current.allowed("/y")).toBe(true);
    // Sites that wrote rules for the pre-3.1 name keep being obeyed.
    const r = Robots.parse("User-agent: *\nDisallow:\n\nUser-agent: SiteArchiverBot\nDisallow: /x\n");
    expect(r.allowed("/x")).toBe(false);
    expect(r.allowed("/y")).toBe(true);
  });
  it("parses sitemap index, urlset and gzip", () => {
    const idx = parseSitemap(`<?xml version="1.0"?><sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>`);
    expect(idx.sitemaps).toEqual(["https://a.com/s1.xml"]);
    const urls = parseSitemap(zlib.gzipSync(`<urlset><url><loc>https://a.com/x</loc></url><url><loc> https://a.com/y </loc></url></urlset>`));
    expect(urls.urls).toEqual(["https://a.com/x", "https://a.com/y"]);
  });
});

describe("visual comparison maths", () => {
  const solid = (w: number, h: number, v: number) => {
    const p = new PNG({ width: w, height: h });
    p.data.fill(v);
    for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
    return PNG.sync.write(p);
  };
  it("reports 0% for identical images and >0 for different ones, plus dimension differences", () => {
    expect(compareImages(solid(10, 10, 0), solid(10, 10, 0)).percent).toBe(0);
    expect(compareImages(solid(10, 10, 0), solid(10, 10, 255)).percent).toBeGreaterThan(90);
    const c = compareImages(solid(10, 10, 0), solid(10, 20, 0));
    expect(c.sourceSize).toEqual({ w: 10, h: 10 });
    expect(c.localSize).toEqual({ w: 10, h: 20 });
    expect(verdictFor(0, false)).toContain("dimensions differ");
    expect(verdictFor(50, true)).toContain("significant");
  });
});
