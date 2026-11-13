import * as cheerio from "cheerio";
import zlib from "node:zlib";

interface Rule {
  allow: boolean;
  pattern: string;
  re: RegExp;
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

/** Minimal RFC 9309 robots.txt evaluator (longest match wins, Allow wins ties). */
export class Robots {
  private rules: Rule[] = [];
  sitemaps: string[] = [];
  crawlDelayMs = 0;

  /** Rules addressed to either product token apply: the current one and the name releases before 3.1 used. */
  static parse(text: string, uaToken = "universalclonebot sitearchiverbot"): Robots {
    const r = new Robots();
    type Group = { agents: string[]; rules: Rule[]; delay: number };
    const groups: Group[] = [];
    let cur: Group | null = null;
    let lastWasAgent = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*/, "").trim();
      if (!line) continue;
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const field = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (field === "sitemap") {
        if (value) r.sitemaps.push(value);
        continue;
      }
      if (field === "user-agent") {
        if (!cur || !lastWasAgent) {
          cur = { agents: [], rules: [], delay: 0 };
          groups.push(cur);
        }
        cur.agents.push(value.toLowerCase());
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (!cur) continue;
      if (field === "allow" || field === "disallow") {
        if (value === "" && field === "disallow") continue; // empty Disallow = allow all
        cur.rules.push({ allow: field === "allow", pattern: value, re: patternToRegex(value) });
      } else if (field === "crawl-delay") {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) cur.delay = n * 1000;
      }
    }
    const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && uaToken.includes(a)));
    const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
    for (const g of chosen) {
      r.rules.push(...g.rules);
      r.crawlDelayMs = Math.max(r.crawlDelayMs, g.delay);
    }
    return r;
  }

  allowed(pathAndQuery: string): boolean {
    let best: Rule | null = null;
    for (const rule of this.rules) {
      if (!rule.re.test(pathAndQuery)) continue;
      if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
    }
    return best ? best.allow : true;
  }
}

export function parseSitemap(body: Buffer | string): { urls: string[]; sitemaps: string[] } {
  let text: string;
  if (Buffer.isBuffer(body)) {
    const buf = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body) : body;
    text = buf.toString("utf8");
  } else text = body;
  const $ = cheerio.load(text, { xmlMode: true });
  const urls: string[] = [];
  const sitemaps: string[] = [];
  $("sitemapindex > sitemap > loc").each((_, el) => {
    sitemaps.push($(el).text().trim());
  });
  $("urlset > url > loc").each((_, el) => {
    urls.push($(el).text().trim());
  });
  $("urlset > url > xhtml\\:link[href]").each((_, el) => {
    const h = $(el).attr("href");
    if (h) urls.push(h.trim());
  });
  return { urls, sitemaps };
}
