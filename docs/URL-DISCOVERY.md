# URL discovery

## Where URLs come from

* The start URL (always accepted, even if it matches an exclude pattern).
* `robots.txt` `Sitemap:` entries, `/sitemap.xml`, `/sitemap_index.xml`; `<sitemapindex>` nesting, `.xml.gz`,
  `xhtml:link` alternates.
* HTML `<a href>`, `<area>`, `<iframe>`, `<link rel=next|prev|first|last>`, `<link rel=canonical>`, `hreflang` alternates,
  `<meta http-equiv=refresh>`.
* The **rendered DOM** in JS/Full mode (links created by scripts) and URLs passed to `history.pushState/replaceState`
  (an init script records them) — client-side route changes.
* Full mode: links revealed after clicking "Load more / Show more / View more / More" buttons (never forms, submit buttons or
  anchors with real destinations).

Not discovered: hash-routed SPAs (`/#/route` — the fragment is dropped), URLs only present in API responses, pages behind
logins, links in `<form action>`.

## Normalisation (`normalizeUrl`)

http/https only · fragment removed · credentials removed · `//` collapsed · trailing slash removed (except `/`) ·
tracking parameters removed (`utm_*`, `fbclid`, `gclid`, `msclkid`, `mc_*`, `_ga`, `_gl`, `igshid`, `yclid`, `twclid`;
configurable) · remaining parameters **sorted** so `?b=1&a=2` ≡ `?a=2&b=1` · `www.` and non-`www` share one visited key.

## Query parameters

* `crawlQueryParams` on (default): `/products?id=123` and `/products?id=456` are different pages and are stored as
  `products/index__id-123.html` / `index__id-456.html`. Off: every query is dropped (all variants collapse).
* `allowParams`: if set, only those parameters survive. `denyParams`: URLs containing them are skipped (default: session ids,
  `replytocom`, `print`, `share`, `action`).
* **Not every variation is useful**, so:
  * at most `maxQueryParams` (3) parameters per URL,
  * at most `maxQueryVariantsPerPath` (30) distinct queries per path (endless `?page=N` stops there — tested),
  * pages whose HTML is byte-identical to an earlier page become aliases (a server ignoring `?x=` does not create copies).

## Trap detection (`detectTrap`)

Skipped with a recorded reason: paths deeper than 15 segments, a path segment repeated 3× (`/a/b/a/b/a/b` loops),
calendar paths (`/calendar/2024/05/12`) and date-valued parameters (`?date=2024-05-01`, `?month=…`) on calendar/event/archive
paths, URLs longer than 2000 characters. Search results (`?s=…`) are only followed when linked (the crawler never submits
forms) and are bounded by the variant cap.

## Scope

Same site = same host (ignoring `www.`) **and port**. Subdomains only with `includeSubdomains` (`blog.example.com` yes,
`evilexample.com` and `example.com.evil.com` never). Optional path-prefix restriction. Include/exclude patterns: `*` globs or
`/regex/`; exclude wins; include (if set) must match. Redirects leaving the scope are refused (after the start URL — a start
URL that redirects to another host re-bases the scope to the final host).

External links are never fetched; they are counted and listed in the report (`externalLinks`).

## Depth, limits and bookkeeping

Depth = clicks from the start URL (sitemap URLs start at depth 1). URLs beyond `maxDepth` or `maxPages` are still
**recorded** as discovered/skipped with a reason, so the report explains why a page is missing, and links to them in the
offline copy go to the fallback page.
