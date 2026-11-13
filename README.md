# Universal Clone 3.1 — deep crawler & offline cloner

Enter **one URL**. The crawler discovers every public page inside the authorised scope (navigation, nested routes,
pagination, meaningful `?query` URLs, sitemaps, JavaScript-rendered links), downloads the assets each page needs,
rewrites links so the copy works offline, and packages everything as a ZIP together with a crawl report.

It can also archive what a site shows **to an account you are authorised to use**: press **Login with Browser**, sign in
yourself in a real, isolated browser (SSO, MFA, CAPTCHA — you answer them, nothing is solved for you), press
**Use This Login** once, and reuse that saved login for this and later downloads. Automatic form login per crawl,
protected assets, API discovery, and a combined mode that records which of several accounts can open which page are
also available.

> Only crawl websites you own or have permission to archive. The crawler never bypasses authentication, paywalls,
> CAPTCHAs, MFA or access controls, respects `robots.txt` by default, and blocks private-network targets.

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
| Login with Browser | Reusable saved logins: the real site in an isolated browser, you sign in by hand, “Use This Login” validates and encrypts the session, then any later crawl can attach it. Create / rename / re-sign-in / forget / delete; one profile per owner **and** site; status, last-used and expiry shown — see [docs/AUTHENTICATED-CRAWLING.md](docs/AUTHENTICATED-CRAWLING.md) |
| Signed-in crawling | Up to 5 login profiles per crawl; form login or manual sign-in in a remote isolated browser; MFA pause/resume; encrypted session reuse and reauthentication; protected assets; API/GraphQL discovery (GET/read-only); separate archives or combined discovery with an access matrix |
| Accounts | Sign-in required for everything; every job belongs to one user; CSRF protection, rate limits, per-user quotas |
| Deployment | Single server, or web tier (e.g. Vercel) + persistent worker processes sharing a PostgreSQL queue; archives on local disk or any S3-compatible bucket — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Recovery | Retries with exponential backoff + `Retry-After`, per-failure report, graceful cancel (partial ZIP), resume after a worker shutdown or crash |
| Safety | SSRF guard (every hop + DNS-rebinding-safe lookup + browser request guard), scope enforcement, quotas, timeouts, rate limits, ZIP path-traversal protection |
| Reports | `crawl-report.json/.html`, `failed-urls.txt`, `discovered-urls.txt`, `assets-manifest.json`, optional visual comparison (desktop/tablet/mobile) |

## Quick start (single server)

```bash
npm install
npx playwright-core install --with-deps chromium   # or set CHROMIUM_PATH to an installed Chromium/Chrome
cp .env.example .env                               # set DATABASE_URL and CRAWLER_CREDENTIAL_ENCRYPTION_KEY
npm run db:migrate                                 # creates / upgrades the schema
npm run user:create -- you@example.com             # accounts are operator-created by default; asks for a password
npm run build && npm start                         # http://localhost:3000
```

No terminal (Vercel, phone browser)? Set `ADMIN_SETUP_KEY` (32+ random characters) in the project's
environment variables and open `/setup-admin` once to create the first administrator — see
[docs/ADMIN-SETUP.md](docs/ADMIN-SETUP.md).

Requires Node 20.12+ and PostgreSQL. No PostgreSQL at hand? `npm run db:dev` starts a real local server from an npm
package and prints its `DATABASE_URL` (development only).

Chromium is needed for JavaScript/Full rendering, signed-in crawling and visual comparison. Without it, public crawls
**fall back to Fast mode with a warning in the log and the report** — they never fail silently.

For Vercel + worker, object storage, scaling and upgrades from 3.0, read **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.
Every environment variable is listed with its default in [`.env.example`](.env.example).

## HTTP API

All routes except `/api/health` and `/api/auth/{login,register,me,setup}` require the session cookie; every non-GET request
also needs the `x-csrf-token` header (value from `/api/auth/me`) and must come from the app's own origin.

| Method & path | Purpose |
|---|---|
| `POST /api/auth/login` `{email, password}` · `POST /api/auth/logout` · `POST /api/auth/register` | session |
| `GET /api/auth/me` | `{user, csrfToken, registration, features}` (`user: null` when signed out) |
| `GET\|POST /api/auth/setup` | one-time first administrator: status (`{setupAvailable, state, message}`) · `{setupKey, email, password, confirmPassword}` → `201` \| `403` \| `409` \| `503` |
| `GET /api/admin/overview` | administrators only: accounts and counts (`403` for `role = user`) |
| `POST /api/crawl` `{url, confirmPermission: true, options?, authProfiles?, authMode?, savedProfileIds?}` | queue a crawl → `201 {id, ids, mode, workerOnline, attachedProfiles}` |
| `GET\|POST /api/login-profiles` | your saved logins + deployment features · create `{name, startUrl, loginUrl?, authenticatedSelector?, matchSubdomains?}` → `201` |
| `GET\|PATCH\|DELETE /api/login-profiles/:id` | metadata (never session material) · rename `{name}` · delete profile + session |
| `GET\|POST\|DELETE /api/login-profiles/:id/session` | session status (`hasSession`, cookie count, expiry — no values) · import a captured request → · forget the saved login |
| `POST\|DELETE /api/login-profiles/:id/browser-login` | open the isolated sign-in window → `201 {session}` · close it |
| `GET\|POST /api/login-profiles/sessions/:sid` | window state (status, page, message) · `{action: "input"…\|"confirm"\|"cancel"}` |
| `GET /api/login-profiles/sessions/:sid/frame` | the current JPEG of the window (`204` when there is nothing to show) |
| `GET /api/crawl` | your history |
| `GET /api/crawl/:id` | job, login profiles (no secrets), open sign-in sessions, recent log |
| `GET /api/crawl/:id/events` | SSE: `snapshot`, `log`, `stats`, `status`, `login`, `job`, `done`; resumable with `Last-Event-ID` |
| `POST /api/crawl/:id/control` `{action: pause\|resume\|cancel}` | control; `resume` also continues an *interrupted* crawl |
| `GET /api/crawl/:id/download` | the ZIP (local storage: streamed; S3: `302` to a short-lived pre-signed link) |
| `GET /api/crawl/:id/report/:file` | report files (sandboxed with a strict CSP) |
| `GET\|POST /api/crawl/:id/auth` | profile status · clear stored credentials and session |
| `GET /api/crawl/:id/login` · `GET\|POST /api/crawl/:id/login/:sid` · `GET …/frame` | manual sign-in: sessions, input/confirm/cancel, screenshot |
| `POST /api/auth/test` | try a form login without crawling (single-server mode only) |
| `DELETE /api/crawl/:id` | delete archive, reports and history row |
| `GET /api/health` | `{ok, worker: "online"\|"offline"}` |

A job id that belongs to someone else answers `404` on every route.

## Using the ZIP

Extract and open `index.html`. If the start URL was not `/`, `index.html` redirects to the archived start page.
Links to pages that were not archived open `__offline__/missing.html` (shows the original address). `_report/` contains the
reports; `__offline__/route-map.json` maps original URLs to local files.

## Tests

```bash
npm run build && npm test           # everything (needs Chromium; starts its own PostgreSQL and S3 test servers)
npm run test:unit                   # fast, no browser, no database
npm run test:db                     # migrations against a real PostgreSQL
npm run test:integration            # crawler + storage
npm run test:e2e                    # production server, worker processes, web UI in a browser
LIVE=1 npx vitest run tests/live    # optional: crawls a public practice site (needs internet)
```

See [docs/TESTING-REPORT.md](docs/TESTING-REPORT.md) for what is covered and the actual results, and
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) for what is **not** supported.

## Documentation

[ARCHITECTURE-AUDIT](docs/ARCHITECTURE-AUDIT.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [CRAWLER-ENGINE](docs/CRAWLER-ENGINE.md) ·
[URL-DISCOVERY](docs/URL-DISCOVERY.md) · [ASSET-DOWNLOADER](docs/ASSET-DOWNLOADER.md) ·
[AUTHENTICATED-CRAWLING](docs/AUTHENTICATED-CRAWLING.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [SECURITY](docs/SECURITY.md) ·
[TESTING-REPORT](docs/TESTING-REPORT.md) · [LIMITATIONS](docs/LIMITATIONS.md)

## Troubleshooting

* **"No crawl worker online" / crawls stay queued** – no worker is connected to this database. Start `npm run worker`
  (web + worker layout) or set `CRAWLER_WORKER_MODE=inline` (single server).
* **Worker exits at start** – it prints why: missing `DATABASE_URL`, Chromium not found/not starting
  (`npm run chromium:check`), or the archive store rejecting its credentials.
* **"Authenticated crawling is disabled"** – set `CRAWLER_CREDENTIAL_ENCRYPTION_KEY` on the web app and the worker.
* **"Login with Browser" says a worker is needed** – the sign-in window is a real browser on the worker; start
  `npm run worker` (or use `CRAWLER_WORKER_MODE=inline`). Saved profiles are kept while no worker is online.
* **Saved login shows "session expired" / "sign-in failed"** – the site no longer accepts the stored session. Press
  **Sign in again**; the profile and its site scope stay as they were.
* **Cannot sign in over plain http** – the session cookie is `Secure` in production; use HTTPS (or
  `AUTH_COOKIE_SECURE=0` for local testing only).
* **Crawl shows "interrupted"** – its worker stopped. Press *Resume*; finished pages are not fetched again.
* **"JavaScript rendering was requested but Chromium could not be launched"** – run
  `npx playwright-core install --with-deps chromium`, or set `CHROMIUM_PATH`.
* **"This address is not allowed"** – the target resolves to a private/loopback/metadata address. This is intentional.
* **Few pages found** – check the report's *Skipped URLs* table (robots.txt, depth, page limit, patterns, traps) and
  try JavaScript rendering for client-rendered sites.
* **Missing images offline** – see `assets-manifest.json` (`status: failed/skipped` with reasons) and the visual report.
* **Crawl stops early** – `stopReason` in the report: time limit, total size quota or page limit.
* **Preview/health** – `GET /api/health`.
