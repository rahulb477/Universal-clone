# Website Downloader v2 — deep crawler & offline cloner

Enter **one URL**. The crawler discovers every public page inside the authorised scope (navigation, nested routes,
pagination, meaningful `?query` URLs, sitemaps, JavaScript-rendered links), downloads the assets each page needs,
rewrites links so the copy works offline, and packages everything as a ZIP together with a crawl report.

> Only crawl websites you own or have permission to archive. The crawler never bypasses authentication, paywalls,
> CAPTCHAs or access controls, respects `robots.txt` by default, and blocks private-network targets.

This is an upgrade of [AhmadIbrahiim/Website-downloader](https://github.com/AhmadIbrahiim/Website-downloader)
(Express + `wget` + Socket.IO). **Read [docs/ARCHITECTURE-AUDIT.md](docs/ARCHITECTURE-AUDIT.md)** for what the original did,
why it stopped at limited pages, and an honest account of what was ported versus replaced.

## Features

| Area | What you get |
|---|---|
| Discovery | BFS queue, `robots.txt` + nested `sitemap.xml`, `<a>`, `rel=next/prev`, canonical, hreflang, pushState routes (render modes), query-parameter pages with normalisation, tracking-param stripping, trap detection (calendar, loops, endless pagination) |
| Rendering | **Fast HTML**, **JavaScript** (Playwright/Chromium snapshot, scroll for lazy-load) and **Full** (also clicks safe "load more" controls, keeps scripts) |
| Assets | HTML/CSS/JS/images/SVG/WebP/fonts/icons/video/documents, CSS `url()` + `@import` (recursive), `srcset`, lazy attributes, Open Graph images, JS string-literal scan, content-hash de-duplication |
| Offline copy | Relative link rewriting, `index.html` per route, query pages as `index__page-2.html`, redirect aliases, local fallback page for unarchived routes, route map |
| Live UI | Start / Pause / Resume / Cancel, advanced settings, live stats + activity log over Server-Sent Events, history, ZIP download, report links |
| Recovery | Retries with exponential backoff + `Retry-After`, per-failure report, graceful cancel (partial ZIP), state snapshots for resume |
| Safety | SSRF guard (every hop + DNS-rebinding-safe lookup + browser request guard), scope enforcement, quotas, timeouts, rate limits, ZIP path-traversal protection |
| Reports | `crawl-report.json/.html`, `failed-urls.txt`, `discovered-urls.txt`, `assets-manifest.json`, optional visual comparison (desktop/tablet/mobile) |

## Quick start

```bash
npm install
npx playwright-core install chromium        # only needed for JavaScript/Full rendering and visual comparison
npx drizzle-kit push                        # creates the crawl_jobs history table
npm run build && npm start                  # http://localhost:3000
```

Requires Node 20+, PostgreSQL (`DATABASE_URL` in `.env`) and — optionally — Chromium plus its system libraries
(`npx playwright-core install-deps chromium` on Debian/Ubuntu with root). If Chromium cannot start, JavaScript/Full
modes **fall back to Fast mode with a warning in the log and the report** — they never fail silently.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | – | PostgreSQL connection (history) |
| `CRAWL_DATA_DIR` | `./.crawl-data` | Where job folders and ZIPs live |
| `CRAWL_RETENTION_HOURS` | `24` | Finished jobs older than this are deleted (files + row) |
| `CRAWLER_MAX_CONCURRENT_JOBS` | `2` | Simultaneous crawls |
| `CRAWLER_STARTS_PER_MINUTE` | `5` | Per-IP crawl-start rate limit |
| `CRAWLER_STORAGE_QUOTA_BYTES` | `5 GiB` | Total stored ZIP size; new crawls are refused beyond it |
| `CRAWLER_HARD_MAX_PAGES` / `CRAWLER_HARD_MAX_TOTAL_BYTES` | `5000` / `2 GiB` | Ceilings user settings are clamped to |
| `CRAWLER_ALLOW_PRIVATE_NETWORKS` | unset | **Operator-only.** `1` lets the server crawl private addresses (intranet use, tests). Never reachable from the API. |
| `CHROMIUM_PATH` | bundled | Use a system Chromium |
| `CRAWLER_CHROMIUM_SANDBOX` | unset | `1` re-enables the Chromium sandbox (we pass `--no-sandbox` by default because containers usually cannot sandbox) |

## HTTP API

| Method & path | Purpose |
|---|---|
| `POST /api/crawl` `{url, options?, confirmPermission:true}` | start a crawl → `{id}` |
| `GET /api/crawl` | history |
| `GET /api/crawl/:id` | job + recent log lines |
| `GET /api/crawl/:id/events` | SSE: `snapshot`, `stats`, `log`, `status`, `done` |
| `POST /api/crawl/:id/control` `{action: pause\|resume\|cancel}` | control (resume also restarts an *interrupted* crawl from its saved state) |
| `GET /api/crawl/:id/download` | the ZIP |
| `GET /api/crawl/:id/report/:file` | report files (sandboxed with a strict CSP) |
| `DELETE /api/crawl/:id` | delete files + history row |

The app has **no user accounts** (the original had none either). Anyone who can reach the server can start crawls and see
history — deploy behind your own authentication/reverse proxy if it is exposed.

## Using the ZIP

Extract and open `index.html`. If the start URL was not `/`, `index.html` redirects to the archived start page.
Links to pages that were not archived open `__offline__/missing.html` (shows the original address). `_report/` contains the
reports; `__offline__/route-map.json` maps original URLs to local files.

## Tests

```bash
npx vitest run                      # unit + integration + browser + API end-to-end (needs `npm run build` and Chromium)
npx vitest run tests/unit           # fast, no browser
LIVE=1 npx vitest run tests/live    # optional: crawls a public practice site (needs internet)
```

See [docs/TESTING-REPORT.md](docs/TESTING-REPORT.md) for what is covered and the actual results, and
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) for what is **not** supported.

## Documentation

[ARCHITECTURE-AUDIT](docs/ARCHITECTURE-AUDIT.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [CRAWLER-ENGINE](docs/CRAWLER-ENGINE.md) ·
[URL-DISCOVERY](docs/URL-DISCOVERY.md) · [ASSET-DOWNLOADER](docs/ASSET-DOWNLOADER.md) · [SECURITY](docs/SECURITY.md) ·
[TESTING-REPORT](docs/TESTING-REPORT.md) · [LIMITATIONS](docs/LIMITATIONS.md)

## Troubleshooting

* **"JavaScript rendering was requested but Chromium could not be launched"** – run `npx playwright-core install chromium`
  and install system libraries (`install-deps`), or set `CHROMIUM_PATH`.
* **"This address is not allowed"** – the target resolves to a private/loopback/metadata address. This is intentional.
* **Few pages found** – check the report's *Skipped URLs* table (robots.txt, depth, page limit, patterns, traps) and
  try JavaScript rendering for client-rendered sites.
* **Missing images offline** – see `assets-manifest.json` (`status: failed/skipped` with reasons) and the visual report.
* **Crawl stops early** – `stopReason` in the report: time limit, total size quota or page limit.
* **Preview/health** – `GET /api/health`.
