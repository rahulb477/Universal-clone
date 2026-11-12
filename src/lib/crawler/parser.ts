import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { isStaticFileUrl } from "./url";

export type RefKind = "link" | "asset" | "discover" | "canonical";

const SKIP_SCHEME = /^(javascript|mailto|tel|data|blob|about|sms|ftp|file|whatsapp|callto):/i;

/** Splits a srcset attribute into candidates. */
export function parseSrcset(value: string): Array<{ url: string; descriptor: string }> {
  return value
    .split(/(?<=\s\d+(?:\.\d+)?[wx]),\s*|,\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^(\S+)\s*(.*)$/.exec(p);
      return m ? { url: m[1], descriptor: m[2] } : { url: p, descriptor: "" };
    });
}

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:"([^"]+)"|'([^']+)')/gi;

/** Rewrites url(...) and @import "..." references in CSS. `visit` returns the replacement or null to keep. */
export function rewriteCss(css: string, visit: (raw: string, kind: "import" | "url") => string | null): string {
  const esc = (s: string) => s.replace(/"/g, "%22");
  let out = css.replace(CSS_IMPORT_RE, (m, a, b) => {
    const raw = (a ?? b) as string;
    if (!raw || SKIP_SCHEME.test(raw.trim())) return m;
    const r = visit(raw.trim(), "import");
    return r ? `@import "${esc(r)}"` : m;
  });
  out = out.replace(CSS_URL_RE, (m, a, b, c) => {
    const raw = ((a ?? b ?? c) as string | undefined)?.trim();
    if (!raw || raw.startsWith("#") || SKIP_SCHEME.test(raw)) return m;
    const r = visit(raw, "url");
    return r ? `url("${esc(r)}")` : m;
  });
  return out;
}

/** Absolute URLs referenced by a stylesheet. */
export function extractCssRefs(css: string, base: string): string[] {
  const out = new Set<string>();
  rewriteCss(css, (raw) => {
    try {
      out.add(new URL(raw, base).href);
    } catch {
      /* ignore */
    }
    return null;
  });
  return [...out];
}

const JS_ASSET_RE =
  /["'`]((?:https?:)?\/\/[^"'`\s\\<>]+?\.(?:png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|mp4|webm|css)(?:\?[^"'`\s\\<>]*)?|\/(?!\/)[^"'`\s\\<>]+?\.(?:png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|mp4|webm)(?:\?[^"'`\s\\<>]*)?)["'`]/gi;

/** Best-effort discovery of asset URLs that only appear as string literals in JavaScript. */
export function extractJsAssetUrls(js: string, base: string, limit = 100): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  JS_ASSET_RE.lastIndex = 0;
  while ((m = JS_ASSET_RE.exec(js)) && out.size < limit) {
    try {
      const u = new URL(m[1], base);
      if (u.protocol === "http:" || u.protocol === "https:") out.add(u.href);
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

export function decodeHtml(buf: Buffer, contentType: string): string {
  let label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!label) {
    const head = buf.subarray(0, 4096).toString("latin1");
    label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) label = "utf-8";
  try {
    return new TextDecoder(label || "utf-8").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

interface Target {
  sel: string;
  attr: string;
  kind: RefKind;
  srcset?: boolean;
}

const TARGETS: Target[] = [
  { sel: "a[href], area[href]", attr: "href", kind: "link" },
  { sel: "iframe[src], frame[src]", attr: "src", kind: "link" },
  { sel: "script[src]", attr: "src", kind: "asset" },
  { sel: "img[src], input[type=image][src], video[src], audio[src], source[src], track[src], embed[src]", attr: "src", kind: "asset" },
  { sel: "video[poster]", attr: "poster", kind: "asset" },
  { sel: "object[data]", attr: "data", kind: "asset" },
  { sel: "img[data-src]", attr: "data-src", kind: "asset" },
  { sel: "img[data-lazy-src]", attr: "data-lazy-src", kind: "asset" },
  { sel: "img[data-original]", attr: "data-original", kind: "asset" },
  { sel: "[data-bg]", attr: "data-bg", kind: "asset" },
  { sel: "[data-background-image]", attr: "data-background-image", kind: "asset" },
  { sel: "video[data-src], source[data-src]", attr: "data-src", kind: "asset" },
  { sel: "img[srcset], source[srcset]", attr: "srcset", kind: "asset", srcset: true },
  { sel: "img[data-srcset], source[data-srcset]", attr: "data-srcset", kind: "asset", srcset: true },
  {
    sel: 'meta[property="og:image"], meta[property="og:image:url"], meta[property="og:image:secure_url"], meta[property="og:video"], meta[property="og:audio"], meta[name="twitter:image"], meta[name="twitter:image:src"], meta[name="msapplication-TileImage"], meta[itemprop="image"]',
    attr: "content",
    kind: "asset",
  },
];

const ASSET_REL = /\b(stylesheet|icon|shortcut|apple-touch-icon|apple-touch-icon-precomposed|manifest|mask-icon|image_src|modulepreload)\b/;
const NAV_REL = /\b(next|prev|previous|first|last|up|start)\b/;

function resolveRef(v: string, base: string): string | null {
  const t = v.trim();
  if (!t || t.startsWith("#") || SKIP_SCHEME.test(t)) return null;
  try {
    const u = new URL(t, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

type Visitor = (abs: string, kind: RefKind) => string | null;

function walk($: CheerioAPI, base: string, visit: Visitor, rewriteMode: boolean, cssVisit: (css: string) => string) {
  const apply = (el: Parameters<CheerioAPI>[0], attr: string, kind: RefKind) => {
    const v = $(el).attr(attr);
    if (!v) return;
    const abs = resolveRef(v, base);
    if (!abs) return;
    const r = visit(abs, kind);
    if (r != null && rewriteMode) $(el).attr(attr, r);
  };
  for (const t of TARGETS) {
    $(t.sel).each((_, el) => {
      if (!t.srcset) return apply(el, t.attr, t.kind);
      const v = $(el).attr(t.attr);
      if (!v) return;
      const cands = parseSrcset(v);
      let changed = false;
      const rebuilt = cands.map((c) => {
        const abs = resolveRef(c.url, base);
        if (!abs) return `${c.url} ${c.descriptor}`.trim();
        const r = visit(abs, "asset");
        if (r != null) changed = true;
        return `${r ?? c.url} ${c.descriptor}`.trim();
      });
      if (changed && rewriteMode) $(el).attr(t.attr, rebuilt.join(", "));
    });
  }
  $("link[href]").each((_, el) => {
    const rel = ($(el).attr("rel") || "").toLowerCase();
    const as = ($(el).attr("as") || "").toLowerCase();
    if (ASSET_REL.test(rel) || (/\b(preload|prefetch)\b/.test(rel) && as !== "fetch" && as !== "document" && as !== "")) apply(el, "href", "asset");
    else if (NAV_REL.test(rel)) apply(el, "href", "link");
    else if (/\bcanonical\b/.test(rel)) apply(el, "href", "canonical");
    else if (/\balternate\b/.test(rel) && $(el).attr("hreflang")) apply(el, "href", "discover");
  });
  $('meta[http-equiv="refresh" i]').each((_, el) => {
    const m = /url\s*=\s*['"]?([^'";]+)/i.exec($(el).attr("content") || "");
    if (m) {
      const abs = resolveRef(m[1], base);
      if (abs) {
        const r = visit(abs, "link");
        if (r != null && rewriteMode) $(el).attr("content", ($(el).attr("content") || "").replace(m[1], r));
      }
    }
  });
  $("[style]").each((_, el) => {
    const css = $(el).attr("style") || "";
    if (!/url\(/i.test(css)) return;
    const out = cssVisit(css);
    if (rewriteMode && out !== css) $(el).attr("style", out.replace(/url\("([^"]*)"\)/g, "url('$1')"));
  });
  $("style").each((_, el) => {
    const css = $(el).html() || "";
    if (!/url\(|@import/i.test(css)) return;
    const out = cssVisit(css);
    if (rewriteMode && out !== css) $(el).html(out);
  });
}

export interface HtmlExtraction {
  title: string;
  links: string[];
  assets: string[];
  /** Same-page links that point at downloadable files (pdf, zip, ...). */
  docs: string[];
  canonical?: string;
  forms: Array<{ action: string; method: string }>;
  embeds: string[];
  jsAssets: string[];
  inlineScripts: number;
}

export function extractFromHtml(html: string, pageUrl: string): HtmlExtraction {
  const $ = cheerio.load(html);
  const baseHref = $("base[href]").first().attr("href");
  let base = pageUrl;
  if (baseHref) {
    const b = resolveRef(baseHref, pageUrl);
    if (b) base = b;
  }
  const links = new Set<string>();
  const assets = new Set<string>();
  const docs = new Set<string>();
  let canonical: string | undefined;
  const embeds = new Set<string>();
  walk(
    $,
    base,
    (abs, kind) => {
      if (kind === "canonical") canonical = abs;
      else if (kind === "link" || kind === "discover") {
        let isStatic = false;
        try {
          isStatic = isStaticFileUrl(new URL(abs));
        } catch {
          /* ignore */
        }
        (isStatic && kind === "link" ? docs : links).add(abs);
      } else assets.add(abs);
      return null;
    },
    false,
    (css) => {
      for (const u of extractCssRefs(css, base)) assets.add(u);
      return css;
    },
  );
  $("iframe[src]").each((_, el) => {
    const abs = resolveRef($(el).attr("src") || "", base);
    if (abs) embeds.add(abs);
  });
  const forms: Array<{ action: string; method: string }> = [];
  $("form").each((_, el) => {
    forms.push({ action: $(el).attr("action") || "", method: ($(el).attr("method") || "get").toLowerCase() });
  });
  const jsAssets = new Set<string>();
  let inlineScripts = 0;
  $("script:not([src])").each((_, el) => {
    const type = ($(el).attr("type") || "").toLowerCase();
    if (type && !/javascript|module/.test(type)) return;
    inlineScripts++;
    for (const u of extractJsAssetUrls($(el).html() || "", base, 50)) jsAssets.add(u);
  });
  return {
    title: $("title").first().text().trim().slice(0, 200),
    links: [...links],
    assets: [...assets],
    docs: [...docs],
    canonical,
    forms,
    embeds: [...embeds],
    jsAssets: [...jsAssets],
    inlineScripts,
  };
}

export interface RewriteOptions {
  stripScripts: boolean;
  banner?: string;
}

const PLACEHOLDER = /^data:|placeholder|blank|spacer|1x1|loader|lazy/i;

/**
 * Rewrites every reference in an HTML document. `resolve` receives an absolute URL
 * and returns the replacement (a local relative path, a fallback link) or null to
 * leave the original untouched. `resolveCss` handles url() inside inline CSS.
 */
export function rewriteHtml(
  html: string,
  pageUrl: string,
  resolve: Visitor,
  resolveCssRaw: (raw: string, base: string) => string | null,
  o: RewriteOptions,
): string {
  const $ = cheerio.load(html);
  const baseHref = $("base[href]").first().attr("href");
  let base = pageUrl;
  if (baseHref) {
    const b = resolveRef(baseHref, pageUrl);
    if (b) base = b;
  }
  // Lazy-loading attributes: promote the real source so the image shows without JavaScript.
  $("img").each((_, el) => {
    const cur = $(el).attr("src");
    const lazy = $(el).attr("data-src") || $(el).attr("data-lazy-src") || $(el).attr("data-original");
    if (lazy && (!cur || PLACEHOLDER.test(cur))) $(el).attr("src", lazy);
    const lazySet = $(el).attr("data-srcset");
    if (lazySet && !$(el).attr("srcset")) $(el).attr("srcset", lazySet);
  });
  $("source[data-srcset]").each((_, el) => {
    if (!$(el).attr("srcset")) $(el).attr("srcset", $(el).attr("data-srcset") || "");
  });
  if (o.stripScripts) {
    $("script").each((_, el) => {
      const type = ($(el).attr("type") || "").toLowerCase();
      if (!type || /javascript|module|text\/babel/.test(type)) $(el).remove();
    });
    $("noscript").remove();
    $('link[rel="modulepreload"], link[rel="preload"][as="script"]').remove();
  }
  walk($, base, resolve, true, (css) => rewriteCss(css, (raw) => resolveCssRaw(raw, base)));
  // Integrity hashes no longer match rewritten files; the archive is local so drop them.
  $("link[integrity], script[integrity]").removeAttr("integrity").removeAttr("crossorigin");
  $("base").remove();
  $("meta[charset], meta[http-equiv='Content-Type' i]").remove();
  if ($("head").length === 0) {
    $("html").prepend("<head></head>");
  }
  $("head").prepend('<meta charset="utf-8">');
  if (o.banner) $("head").prepend(`<!-- ${o.banner.replace(/--+/g, "-")} -->`);
  return $.html();
}
