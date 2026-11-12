# Testing report

All results below were produced by actually running the suites in the development sandbox (Node 22, Chromium headless shell
158, PostgreSQL local). Nothing here is aspirational. Re-run with `npx vitest run` (needs `npm run build` for the API suite).

## Result of the last full run

```
Test Files  6 passed | 1 skipped (7)         (the skipped file is the opt-in live test)
     Tests  141 passed | 2 skipped (143)     duration 146 s
```

| Suite | Tests | Scope |
|---|---|---|
| `tests/unit/security.test.ts` | 51 | SSRF IP/host/scheme tables, redirect-hop validation, redirect loops, streaming size cap, path traversal |
| `tests/unit/url.test.ts` | 29 | normalisation, query rules, traps, local path mapping, collision registry, scope, patterns, option clamping |
| `tests/unit/parser.test.ts` | 14 | srcset, CSS/JS reference extraction, HTML extraction + rewriting, charsets, robots.txt, sitemaps, image comparison maths |
| `tests/integration/crawl.test.ts` | 32 | full crawls of a local multi-feature site (see mapping below) |
| `tests/e2e/browser.test.ts` | 9 | real Chromium: JS rendering, SPA, lazy loading, full-mode interaction, render guard, offline click-through, visual comparison |
| `tests/e2e/api.test.ts` | 6 | the **production server** (`next start`) over HTTP + SSE: start, live events, ZIP, reports, history, pause/resume/cancel, SSRF refusal |
| `tests/live/live.test.ts` | 2 (opt-in) | `LIVE=1`: crawl of `quotes.toscrape.com` (real DNS + HTTP). Last run: **2 passed** — 53 pages stored, 7 redirect/duplicate aliases, 5 assets, 6 genuine 404 font files reported as missing |

Test sites are local servers we control (`tests/fixtures/site.ts`): ~45 routes with nested paths, query URLs, pagination, an
endless pagination trap, a calendar trap, robots.txt, nested sitemaps, JS-generated links, a pushState SPA, lazy images,
CSS `@import`/backgrounds/fonts, duplicate images, flaky/rate-limited/permanently failing endpoints, soft-404 images, slow
pages, a 2 MB file, redirects (internal, external, loop), and a second origin for the domain-boundary test.

## Mapping to the 18 required scenarios

| # | Scenario | Test(s) | Result |
|---|---|---|---|
| 1 | Simple multi-page site | integration "1. discovers simple multi-page navigation" | pass (≥ 20 pages from one URL) |
| 2 | Deep nested routes | "2. downloads deeply nested routes" (4 levels) | pass |
| 3 | Query-parameter URLs | "3. …" (`?id=123/456`, `?category=`, tracking params stripped, order-insensitive, utm duplicate not fetched twice); `crawlQueryParams=false` | pass |
| 4 | Pagination | "4. follows pagination and caps endless pagination" + calendar trap test | pass |
| 5 | Sitemap discovery | "5. …" (index → nested sitemaps; pages linked from nowhere) | pass |
| 6 | JavaScript-rendered pages | browser "6. fast mode misses JS-generated links; JS mode finds them" | pass |
| 7 | SPA navigation | browser "7. SPA…" (pushState routes, rendered content per route) + offline SPA copy | pass |
| 8 | Lazy-loaded images | integration (`data-src`, no JS) and browser (IntersectionObserver below the fold, needs scrolling) | pass |
| 9 | CSS background assets | "9. rewrites CSS url() and @import…", inline `style`, `<style>` | pass |
| 10 | Font downloads | same test: `woff2`/`woff` downloaded and URLs rewritten | pass for download + rewrite. The fixture fonts are dummy bytes; real font *rendering* was not verified. |
| 11 | Duplicate assets | "11. detects duplicate assets by content hash" | pass (after a bug fix, see below) |
| 12 | Offline link rewriting | "12. …", "every local link resolves to a file", fallback page, redirect aliases, **browser click-through with all http(s) blocked: 0 network requests, 0 page errors** | pass |
| 13 | ZIP integrity | "13. produces an intact ZIP…" (`AdmZip.test()`, entry-name safety, report files) and API ZIP download | pass |
| 14 | Failed request recovery | "14. …": 500,500,200 → OK; 429+`Retry-After` → OK; asset 503,503 → OK; 404 hit once; permanent 500 hit 4× and reported with attempts | pass |
| 15 | Cancellation | "15. cancels gracefully…" (partial valid ZIP), pause/resume freeze test, API pause/resume/cancel | pass |
| 16 | SSRF protection | 51 unit tests + crawler-level refusal (server never contacted) + API 400s + browser render guard | pass |
| 17 | Domain boundary | "17. never leaves the domain scope" (external server received **0** requests; out-of-scope redirect refused), scope unit tests | pass |
| 18 | Resource quotas | total-size quota, per-file cap while streaming, max pages, max depth, wall-clock limit (partial ZIP) | pass |

Also tested: robots.txt compliance, include/exclude patterns, assets toggle, resume from a saved snapshot (finished pages are
not requested again), ZIP/disk cleanup after packaging, option clamping, malformed job ids / report path traversal at the API.

## Visual comparison — measured values

Run on the fixture `/about` page (simple HTML + CSS), source vs offline copy:

| Viewport | Pixel mismatch | Verdict |
|---|---|---|
| desktop 1366×900 | 0.000 % | close match |
| tablet 768×1024 | 0.000 % | close match |
| mobile 390×844 | 0.000 % | close match |

This only shows the pipeline works on a trivial page (and a second test proves it *detects* offline-missing resources).
It is **not** evidence of fidelity on real-world sites.

## Bugs the tests found (and which were fixed)

1. **HTTP size limit misclassified** – destroying the response emitted `aborted` before our `too_large` rejection, so oversize
   downloads were reported as generic network errors (and retried). Fixed by rejecting before destroying. (unit test)
2. **Duplicate-asset race** – two identical images downloaded concurrently were both stored because the hash was registered
   after the first `await`. Fixed by claiming hash and path synchronously. (integration test)
3. **Missing assets pointed at the disk root** – a failed `url(/img/x.png)` stayed root-relative, which resolves to `file:///img/x.png`
   offline. Now rewritten to the absolute live URL and reported. (integration test)
4. **Query suffix naming** – `index__id-123-<hash>.html` was needlessly ugly; simplified for common `a=b&c=d` queries.
5. **Missing file-type** – `.bin`, `.exe`, `.iso`… links were treated as pages; added to the static-file set.
6. **Control API** – pausing an already finished job returned 200; now 409. (API test)
7. **Style attribute quoting** – inline `style` rewritten to `url("…")` produced `&quot;` in attributes; now single quotes.

Several first-run failures were wrong test fixtures/expectations (e.g. a fixture that returned the same page for every
`?id=`, which the engine *correctly* de-duplicated) — those were fixed in the tests, not hidden.

## Not tested / known gaps

* Real process kill + restart resume (only snapshot-copy resume is tested).
* Subdomain crawling with real DNS names (scope logic is unit-tested; the fixtures use loopback ports).
* Large crawls (thousands of pages), memory profile under 8 workers × large files.
* HTTPS/SSL error paths (classification code exists; no TLS fixture was built).
* Windows/macOS file-system behaviour of the generated paths (names are restricted to portable characters but were only run on Linux).
* Rendering of real fonts/frameworks (React/Vue/Angular/Next production sites) — only synthetic SPA/JS fixtures.
