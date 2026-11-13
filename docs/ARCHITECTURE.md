# Architecture

```
src/
  app/page.tsx, components/AccountGate.tsx     sign-in gate; nothing else renders for anonymous visitors
  components/Downloader.tsx, LoginPanel.tsx    dashboard (EventSource) and the remote sign-in window
  app/api/auth/**                              register / login / logout / me / test
  app/api/crawl/**                             REST + SSE routes (Node runtime); every route checks the owner
  proxy.ts                                     response security headers (run time, not build time)
  instrumentation.ts                           starts the in-process worker in "inline" mode
  db/schema.ts, db/migrate.ts                  9 tables; SQL migrations in drizzle/ applied by `npm run db:migrate`
  lib/server/
    users.ts      passwords, sessions, cookies, CSRF, rate limits, registration
    jobs.ts       create / list / control / delete jobs, credentials, sign-in sessions — all scoped by owner
    storage.ts    ArchiveStore: LocalStore | S3Store (built-in Signature V4), pre-signed downloads
    config.ts     limits, worker mode, data directory
    inline-worker.ts
  worker/
    worker.ts     CrawlWorker: claim, heartbeat, run, stream events, commands, upload, recover stale jobs, retention
    main.ts       `npm run worker`: dependency checks, /healthz, SIGTERM handling
  lib/crawler/
    types.ts      options, defaults, hard limits, sanitizeOptions(), stats/log types
    security.ts   SSRF (IP/host rules, guarded DNS lookup), safeJoin, archive-name check
    http.ts       GET over node:http(s), manual redirects, per-hop headers, streaming size cap, retries, per-host throttle
    url.ts        normalisation, scope, trap detection, local path mapping, PathRegistry, patterns
    parser.ts     HTML/CSS/srcset/JS reference extraction + HTML/CSS rewriting (one shared attribute table)
    robots.ts     robots.txt evaluator, sitemap parser (index, urlset, gzip)
    renderer.ts   Playwright/Chromium: guarded contexts, stabilise, scroll, safe interaction, form login
    auth.ts       profile validation, AES-256-GCM envelopes
    interactive-login.ts   the isolated sign-in browser driven by the user (frames out, validated input in)
    api-discovery.ts       fetch/XHR recording, redaction, GET pagination, read-only GraphQL
    assets.ts, public-assets.ts   AssetManager (dedupe by URL + sha256, quotas); cache of session-free assets
    engine.ts     Crawler (EventEmitter): queue, workers, pause/resume/cancel/suspend, sessions, finalise, snapshots
    combined.ts   CombinedCrawler: one Crawler per profile, merged URL inventory, access matrix
    report.ts     crawl-report.json/.html, failed-urls.txt, discovered-urls.txt, assets-manifest.json
    visual.ts     screenshot comparison (pixelmatch)
    zip.ts        safe streaming ZIP
scripts/          create-user, chromium-env (browser lookup), dev-postgres, load-env
tests/            unit, db, integration, e2e (production server, worker processes, browser UI), live (opt-in)
```

## Processes and data flow

```
browser ──HTTPS──► web app (Next.js) ──────────────► PostgreSQL ◄────────────── worker(s)
                     │  users, user_sessions            crawl_jobs  (queue: FOR UPDATE SKIP LOCKED)
                     │  INSERT crawl_jobs 'queued'      job_commands (pause / resume / cancel / sign-in input)
                     │  INSERT job_commands             job_events   (log lines → SSE)
                     │  SELECT job_events ─► SSE        auth_profiles, login_sessions (encrypted)
                     │                                  workers (heartbeat), rate_events
                     └─ archive store ◄── ZIP + reports uploaded by the worker (local dir or S3 bucket)
```

* The web app never starts a browser and never fetches a user-supplied URL. `CRAWLER_WORKER_MODE=inline` runs the same
  `CrawlWorker` inside the web process (single server); `external` leaves it to `npm run worker` processes.
* A worker claims the oldest queued job atomically, heartbeats every 5 s, applies commands, batches log/stats rows, and
  on completion uploads the archive and clears the job's credentials. A job whose worker stops heart-beating for
  `WORKER_STALE_SECONDS` is marked `interrupted` by any other worker; resuming is the owner's decision.
* Job statuses: `queued → running ⇄ paused → completed | cancelled | failed`, plus `interrupted` (worker stopped) which
  `resume` puts back to `queued`.
* The live stream is polling-based on the server (PostgreSQL → SSE every 0.7 s) so that any web instance can serve any
  job; it resumes from `Last-Event-ID`.

```
Crawler.run:  [sign in / restore session] ─► robots+sitemaps ─► workers ─► processPage* ─► finalize:
   rewrite HTML (+CSS) ─► offline helpers ─► [visual compare] ─► reports ─► ZIP ─► delete raw+site dirs
```

Two-phase design: during the crawl pages are stored **raw** (`raw/<n>.html`) and assets are written to their final path.
Only after the crawl ends — when the complete route map is known — pages are rewritten. This is what makes links between
pages that were discovered in any order resolve correctly, and what lets a cancelled/limited crawl still produce a
consistent partial archive (links to pages that were never fetched go to the local fallback page).

## On-disk layout of a job (`CRAWL_DATA_DIR/<id>/`, on the worker)

During the crawl: `raw/`, `site/`, `state.json` (snapshot, at most ~3 s old; contains no credentials), and
`profiles/<n>/` for a combined crawl. After packaging, the ZIP and the reports are moved to the archive store
(`jobs/<id>/site.zip`, `jobs/<id>/report/<file>`) and the directory is deleted.

## ZIP layout

```
index.html                      start page (or a redirect to it)
<path>/index.html               one folder per route
index__page-2.html              query pages: <route>/index__<query>.html
css/ img/ fonts/ js/ …          assets keep their original path
_ext/<host>/…                   assets hosted on other domains
_sub/<host>/…                   pages on included subdomains
__offline__/missing.html        fallback for unarchived pages;  route-map.json
_report/…                       reports (+ visual/ screenshots, api-discovery.json when applicable)
profiles/<name>/…               combined discovery only: one such tree per login profile
_report/access-matrix.{json,csv}, combined-report.json      combined discovery only
```

## Concurrency model

`concurrency` page workers (1–8) pull from one queue. A global semaphore (`3 × concurrency`) bounds in-flight HTTP requests;
a per-host throttle spaces request starts by `delayMs` (or the robots `Crawl-delay`, capped at 10 s). Browser contexts are
limited to 3 at once. Everything is cooperative (no worker threads). A worker runs up to
`CRAWLER_MAX_CONCURRENT_JOBS` crawls side by side in one process.
