import http from "node:http";
import { PNG } from "pngjs";
import type { AddressInfo } from "node:net";

function png(color: number): Buffer {
  const p = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = color;
    p.data[i + 1] = 100;
    p.data[i + 2] = 200;
    p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
}
function colorFor(name: string): number {
  if (name.startsWith("dup")) return 7;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 250;
  return h;
}

const SHELL_CSS = `
@import url("/css/imported.css");
body{font-family:sans-serif}
.hero{background:url(/img/bg.png) no-repeat;height:50px}
@font-face{font-family:T;src:url(/fonts/test.woff2) format("woff2"),url("/fonts/test.woff") format("woff")}
.missing{background:url(/img/missing.png)}
`;

export interface Fixture {
  url: string;
  port: number;
  hits: Map<string, number>;
  slowMs: number;
  close(): Promise<void>;
}

function page(title: string, body: string, extraHead = ""): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/css/main.css"><link rel="icon" href="/favicon.png">${extraHead}</head><body>
<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a> <a href="/services/">Services</a> <a href="/blog">Blog</a> <a href="/products">Products</a></nav>
<h1>${title}</h1>${body}<script src="/js/app.js"></script></body></html>`;
}

export async function startFixture(externalUrl?: string): Promise<Fixture> {
  const hits = new Map<string, number>();
  const counters = new Map<string, number>();
  const fx = { slowMs: 0 } as { slowMs: number };
  const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const server = http.createServer(async (req, res) => {
    const raw = req.url || "/";
    hits.set(raw, (hits.get(raw) ?? 0) + 1);
    const u = new URL(raw, "http://x");
    const p = u.pathname;
    const send = (status: number, body: string | Buffer, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    const count = (k: string) => {
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      return n;
    };

    if (p === "/robots.txt") return send(200, `User-agent: *\nDisallow: /secret\nSitemap: ${origin()}/sitemap.xml\n`, "text/plain");
    if (p === "/sitemap.xml")
      return send(200, `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin()}/sitemap-1.xml</loc></sitemap><sitemap><loc>${origin()}/sitemap-2.xml</loc></sitemap></sitemapindex>`, "application/xml");
    if (p === "/sitemap-1.xml") return send(200, `<?xml version="1.0"?><urlset><url><loc>${origin()}/hidden</loc></url></urlset>`, "application/xml");
    if (p === "/sitemap-index.xml") return send(404, "no");
    if (p === "/sitemap-2.xml") return send(200, `<?xml version="1.0"?><urlset><url><loc>${origin()}/hidden-nested</loc></url></urlset>`, "application/xml");

    // ---- assets ----
    if (p === "/css/main.css") return send(200, SHELL_CSS, "text/css");
    if (p === "/css/imported.css") return send(200, `.imp{background:url(../img/imp.png)}`, "text/css");
    if (p === "/js/app.js") return send(200, `window.__app=1; var x="/img/from-js.png";`, "application/javascript");
    if (p === "/favicon.png") return send(200, png(1), "image/png");
    if (p.startsWith("/img/")) {
      const name = p.slice(5);
      if (name === "missing.png") return send(404, "nope");
      if (name === "flaky.png" && count("flaky-img") < 3) return send(503, "busy");
      return send(200, png(colorFor(name)), "image/png");
    }
    if (p === "/soft404.png") return send(200, "<html>not found page</html>");
    if (p === "/fonts/test.woff2") return send(200, Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(200, 1)]), "font/woff2");
    if (p === "/fonts/test.woff") return send(200, Buffer.concat([Buffer.from("wOFF"), Buffer.alloc(200, 2)]), "font/woff");
    if (p === "/files/doc.pdf") return send(200, Buffer.from("%PDF-1.4 fake"), "application/pdf");
    if (p === "/files/big.bin") return send(200, Buffer.alloc(2 * 1024 * 1024, 5), "application/octet-stream");

    // ---- pages ----
    if (p === "/") {
      const pg = u.searchParams.get("page");
      if (pg === "2") return send(200, page("Home page 2", `<p>second home page</p><a href="/?page=3">next</a>`));
      if (pg === "3") return send(200, page("Home page 3", `<p>third</p>`));
      if (u.searchParams.get("category")) return send(200, page("Category " + u.searchParams.get("category"), `<p>cat</p>`));
      return send(
        200,
        page(
          "Home",
          `<div class="hero"></div><img src="/img/logo.png" alt="logo"><img src="/img/dup-a.png"><img src="/img/dup-b.png">
<a href="/?page=2">page 2</a> <a href="/?category=technology">tech</a> <a href="/about?utm_source=news&fbclid=abc">about tracked</a>
<a href="/about/">about slash</a> <a href="/news?page=1">news</a> <a href="/endless?page=1">endless</a>
<a href="/files/doc.pdf">PDF</a> <a href="/nope">broken</a> <a href="/secret">secret</a> <a href="/flaky">flaky</a> <a href="/always-500">always500</a>
<a href="/ratelimited">rl</a> <a href="/assets-test">assets</a> <a href="/lazy">lazy</a> <a href="/js">js</a> <a href="/spa">spa</a> <a href="/loadmore">loadmore</a>
<a href="/redirect">redirect</a> <a href="/redirect-external">redir-ext</a> <a href="/calendar/2024/05/01">cal</a>
<a href="${externalUrl ?? "http://example.invalid"}/ext">external</a> <a href="/big">big</a>
<picture><source srcset="/img/r-480.png 480w, /img/r-960.png 960w"><img src="/img/r-480.png" srcset="/img/r-480.png 480w,/img/r-960.png 960w"></picture>`,
          `<meta property="og:image" content="/img/og.png">`,
        ),
      );
    }
    if (p === "/about") return send(200, page("About", `<p>About us</p><a href="/team">Team</a>`));
    if (p === "/team") return send(200, page("Team", "<p>team</p>"));
    if (p === "/contact") return send(200, page("Contact", `<form method="post" action="/contact"><input name=a></form>`));
    if (p === "/services") return send(200, page("Services", `<a href="/services/web-development">Web development</a>`));
    if (p === "/services/web-development") return send(200, page("Web Development", `<a href="/services/web-development/pricing">Pricing</a>`));
    if (p === "/services/web-development/pricing") return send(200, page("Pricing", `<a href="/services/web-development/pricing/enterprise">Enterprise</a>`));
    if (p === "/services/web-development/pricing/enterprise") return send(200, page("Enterprise", `<p>deep page</p>`));
    if (p === "/blog") return send(200, page("Blog", `<a href="/blog/article-1">One</a> <a href="/blog/article-2">Two</a>`));
    if (p === "/blog/article-1") return send(200, page("Article 1", `<p>first article</p>`));
    if (p === "/blog/article-2") return send(200, page("Article 2", `<p>second article</p>`));
    if (p === "/products" && u.searchParams.get("id")) return send(200, page("Product " + u.searchParams.get("id"), `<p>details of product ${u.searchParams.get("id")}</p>`));
    if (p === "/products") return send(200, page("Products", `<a href="/products?id=123">P123</a> <a href="/products?id=456">P456</a> <a href="/products?id=456&utm_campaign=z">dup</a>`));
    if (p === "/news") {
      const n = Number(u.searchParams.get("page") || 1);
      return send(200, page(`News ${n}`, `<p>news page ${n}</p>${n < 3 ? `<a rel="next" href="/news?page=${n + 1}">next</a>` : ""}`));
    }
    if (p === "/endless") {
      const n = Number(u.searchParams.get("page") || 1);
      return send(200, page(`Endless ${n}`, `<p>endless ${n}</p><a href="/endless?page=${n + 1}">next</a>`));
    }
    if (p.startsWith("/calendar/")) {
      const m = /(\d{4})\/(\d{2})\/(\d{2})/.exec(p);
      const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1)) : new Date();
      const nxt = `/calendar/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
      return send(200, page("Calendar " + p, `<a href="${nxt}">next day</a>`));
    }
    if (p === "/hidden") return send(200, page("Hidden", "<p>only in sitemap</p>"));
    if (p === "/hidden-nested") return send(200, page("Hidden nested", "<p>only in nested sitemap</p>"));
    if (p === "/secret") return send(200, page("Secret", "<p>robots disallowed</p>"));
    if (p === "/flaky") return count("flaky") < 3 ? send(500, "oops") : send(200, page("Flaky OK", `<img src="/img/flaky.png">`));
    if (p === "/always-500") return send(500, "always broken");
    if (p === "/ratelimited") return count("rl") < 2 ? send(429, "slow down", "text/plain", { "retry-after": "0" }) : send(200, page("Rate limited OK", "<p>ok</p>"));
    if (p === "/assets-test")
      return send(
        200,
        page(
          "Assets",
          `<div class="hero"></div><img src="/img/dup-a.png"><img src="/img/dup-b.png"><img src="/img/missing.png"><img src="/soft404.png">
<div style="background-image:url('/img/inline-bg.png')">x</div><style>.s{background:url(/img/style-tag.png)}</style>`,
        ),
      );
    if (p === "/big") return send(200, page("Big", `<a href="/files/big.bin">download</a>`));
    if (p === "/lazy")
      return send(
        200,
        page(
          "Lazy",
          `<img class="lz" data-src="/img/lazy-1.png" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="100" height="100">
<div style="height:3000px">spacer</div>
<img class="lz" data-src="/img/lazy-2.png" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="100" height="100">
<script>var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.src=e.target.dataset.src;io.unobserve(e.target)}})});document.querySelectorAll('.lz').forEach(function(i){io.observe(i)})</script>`,
        ),
      );
    if (p === "/js")
      return send(200, page("JS page", `<div id="d"></div><script>setTimeout(function(){document.getElementById('d').innerHTML='<a href="/js-found">dynamic link</a><img src="/img/js-img.png">'},200)</script>`));
    if (p === "/js-found") return send(200, page("JS found", "<p>discovered through rendering</p>"));
    if (p === "/loadmore")
      return send(
        200,
        page(
          "Load more",
          `<div id="l"></div><button id="b" type="button">Load more</button><script>document.getElementById('b').onclick=function(){document.getElementById('l').innerHTML='<a href="/loaded-item">loaded item</a>'}</script>`,
        ),
      );
    if (p === "/loaded-item") return send(200, page("Loaded item", "<p>after click</p>"));
    if (p === "/spa" || p.startsWith("/spa/")) {
      return send(
        200,
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SPA</title></head><body><div id="app"></div><script>
var names={'/spa':'SPA Home','/spa/a':'SPA Page A','/spa/b':'SPA Page B'};
function render(){var p=location.pathname;document.getElementById('app').innerHTML='<h1>'+(names[p]||'SPA 404')+'</h1><nav><a href="/spa">Home</a> <a href="/spa/a">A</a> <a href="/spa/b">B</a></nav><img src="/img/spa-'+p.replace(/\\W/g,'')+'.png">';}
document.addEventListener('click',function(e){var a=e.target.closest('a');if(a){e.preventDefault();history.pushState({},'',a.getAttribute('href'));render();}});
render();</script></body></html>`,
      );
    }
    if (p === "/redirect") return send(302, "", "text/plain", { location: "/team" });
    if (p === "/redirect-external") return send(302, "", "text/plain", { location: (externalUrl ?? "http://example.invalid") + "/ext" });
    if (p === "/redirect-loop") return send(302, "", "text/plain", { location: "/redirect-loop" });
    if (p.startsWith("/slow/")) {
      const n = Number(p.slice(6));
      await new Promise((r) => setTimeout(r, fx.slowMs));
      return send(200, `<!DOCTYPE html><html><head><title>Slow ${n}</title></head><body><h1>Slow ${n}</h1>${n < 50 ? `<a href="/slow/${n + 1}">next</a>` : ""}</body></html>`);
    }
    send(404, page("Not found", "<p>404</p>"));
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    get slowMs() {
      return fx.slowMs;
    },
    set slowMs(v: number) {
      fx.slowMs = v;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** A second origin used to verify domain-boundary enforcement. */
export async function startExternal(): Promise<{ url: string; hits: Map<string, number>; close(): Promise<void> }> {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    hits.set(req.url || "/", (hits.get(req.url || "/") ?? 0) + 1);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>EXTERNAL SITE</h1></body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
