# Architecture

```
src/
  app/page.tsx, components/Downloader.tsx     dashboard (React, EventSource)
  app/api/crawl/**                            REST + SSE routes (Node runtime)
  db/schema.ts                                crawl_jobs (history)
  lib/crawler/
    types.ts      options, defaults, hard limits, sanitizeOptions(), stats/log types
    security.ts   SSRF (IP/host rules, guarded DNS lookup), safeJoin, archive-name check
    http.ts       GET over node:http(s), manual redirects, streaming size cap, retries/backoff, per-host throttle
    url.ts        normalisation, scope, trap detection, local path mapping, PathRegistry, patterns
    parser.ts     HTML/CSS/srcset/JS reference extraction + HTML/CSS rewriting (one shared attribute table)
    robots.ts     robots.txt evaluator, sitemap parser (index, urlset, gzip)
    renderer.ts   Playwright/Chromium: guarded context, stabilise, scroll, safe interaction
    assets.ts     AssetManager: dedupe by URL + sha256, quotas, CSS/JS child discovery
    engine.ts     Crawler (EventEmitter): queue, workers, pause/resume/cancel, finalise, state snapshots
    report.ts     crawl-report.json/.html, failed-urls.txt, discovered-urls.txt, assets-manifest.json
    visual.ts     screenshot comparison (pixelmatch)
    zip.ts        safe streaming ZIP
    manager.ts    JobManager singleton: DB persistence, quotas, rate limits, SSE fan-out
tests/            unit, integration (fixture site), e2e (browser + production server), live (opt-in)
```

## Data flow

```
POST /api/crawl ─► JobManager.start ─► assertPublicUrl ─► INSERT crawl_jobs ─► new Crawler(...).run()
                                                                 │ events: log / stats / status
                                      SSE /events ◄── fan-out ◄──┘
Crawler.run:  robots+sitemaps ─► workers ─► processPage* ─► finalize:
   rewrite HTML (+CSS) ─► offline helpers ─► [visual compare] ─► reports ─► ZIP ─► delete raw+site dirs
```

Two-phase design: during the crawl pages are stored **raw** (`raw/<n>.html`) and assets are written to their final path.
Only after the crawl ends — when the complete route map is known — pages are rewritten. This is what makes links between
pages that were discovered in any order resolve correctly, and what lets a cancelled/limited crawl still produce a
consistent partial archive (links to pages that were never fetched go to the local fallback page).

## On-disk layout of a job (`CRAWL_DATA_DIR/<id>/`)

During the crawl: `raw/`, `site/`, `state.json` (snapshot). After packaging: `site.zip` and `report/` only.

## ZIP layout

```
index.html                      start page (or a redirect to it)
<path>/index.html               one folder per route
index__page-2.html              query pages: <route>/index__<query>.html
css/ img/ fonts/ js/ …          assets keep their original path
_ext/<host>/…                   assets hosted on other domains
_sub/<host>/…                   pages on included subdomains
__offline__/missing.html        fallback for unarchived pages;  route-map.json
_report/…                       reports (+ visual/ screenshots when requested)
```

## Concurrency model

`concurrency` page workers (1–8) pull from one queue. A global semaphore (`3 × concurrency`) bounds in-flight HTTP requests;
a per-host throttle spaces request starts by `delayMs` (or the robots `Crawl-delay`, capped at 10 s). Browser contexts are
limited to 3 at once. Everything is cooperative (no worker threads), so the Next.js server stays responsive.
