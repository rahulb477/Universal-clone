# Testing report

Everything below was produced by running the suites in the development sandbox (Debian 12, Node 22.22). Nothing is
aspirational; what could not be run or was not covered is listed under **Not tested** at the end.

## Environment actually used

| Component | What ran | Note |
|---|---|---|
| Browser | **Chromium 153.0.8010.0** from the npm package `@sparticuz/chromium` | Not the build `playwright-core` 1.65 expects (see below) |
| Database | **PostgreSQL 18.6**, a real server started from the npm package `embedded-postgres` | One fresh cluster per test file |
| Object storage | `s3rver` 3.7.1 (S3 API on localhost) behind a signature-verifying gate | No AWS, R2 or MinIO endpoint was contacted |
| Web app | the production build (`next build`, then `next start`) | Not `next dev` |
| Worker | `node --import ./scripts/load-env.mjs --import tsx src/worker/main.ts` — the `npm run worker` command — as separate OS processes | |

**Playwright's own Chromium could not be installed.** `npx playwright-core install chromium` failed with:

```
Error: Client network socket disconnected before secure TLS connection was established
  code: 'ECONNRESET', host: 'cdn.playwright.dev', port: 443
Failed to install browsers
Error: Failed to download Chrome for Testing 158.0.8127.18 (playwright chromium v1254), caused by
Error: Download failure, code=1
```

The sandbox only reaches the npm registry and GitHub, so the browser tests ran on the Chromium build that the npm
registry can deliver. It is a real Chromium (not a mock), but **five major versions older** than the one this
Playwright release is built against, and it is launched with `--no-sandbox`. Results on Playwright's own Chromium 158
are therefore unverified. `scripts/chromium-env.mjs` picks the browser (operator path → Playwright's → npm package);
`npm run chromium:check` prints which one is in use.

## Result of the last full run

`npm run typecheck` — clean. `npm run lint` — clean, no warnings. `npm run build` — compiled successfully.
`npx vitest run` (all files, one after another):

```
Test Files  18 passed | 1 skipped (19)       (the skipped file is the opt-in live test)
     Tests  299 passed | 2 skipped (301)
```

Per suite, in the run of this build: `tests/unit` + `tests/db` **142 passed** (7 files, 50 s), `tests/integration`
**84 passed** (5 files, 232 s), `tests/e2e` **73 passed** (6 files, 517 s). `npm run typecheck`, `npm run lint` and
`npm run build` are clean. Timings are from this sandbox (2 vCPU); a slower machine would take longer.

The 30 tests added for the one-time first-administrator setup (V3.1.1) are included above: 8 in
`tests/unit/setup.test.ts`, 19 in `tests/e2e/setup-admin.test.ts`, 1 in `tests/db/migrations.test.ts` and the
updated migration ledger expectations in `tests/e2e/api.test.ts`.

The 49 tests for reusable “Login with Browser” profiles (this release) are included: 23 in
`tests/unit/saved-login.test.ts`, 18 in `tests/integration/saved-login-profiles.test.ts` and 8 in
`tests/e2e/saved-login-ui.test.ts`. `tests/e2e/ui.test.ts` also gained the new sign-in step and
`tests/db/migrations.test.ts` the new migration.

This is one clean run made after the last code change. Two earlier full runs in the same pass each had one failing
test, both timing-related and both since fixed in the product (the sign-in panel requested a frame just after the
sign-in ended; the sign-in session's page address was published a moment after the session itself). The suites are
timing-sensitive by nature — real browsers, real processes, real signals — so an occasional flaky run on a slower
machine would not be surprising; that has not been measured.

| Suite | Tests | What it exercises |
|---|---|---|
| `tests/unit/security.test.ts` | 51 | SSRF IP/host/scheme tables, redirect-hop validation, redirect loops, streaming size cap, path traversal |
| `tests/unit/url.test.ts` | 29 | normalisation, query rules, traps, local path mapping, collision registry, scope, patterns, option clamping |
| `tests/unit/parser.test.ts` | 14 | srcset, CSS/JS reference extraction, HTML extraction + rewriting, charsets, robots.txt (current and pre-3.1 bot name), sitemaps |
| `tests/unit/auth.test.ts` | 3 | credential envelopes (tamper rejection), safe profile projection, unsafe login URLs |
| `tests/unit/saved-login.test.ts` | 23 | saved-login rules: address normalisation, host scoping (exact host+port, parent domain always, sub-domain only with the flag, never a suffix/substring match), AES-256-GCM envelopes bound to profile+owner+host, request-capture parsing and cookie-header redaction, input validation, and the browser-side host matcher the panel uses |
| `tests/db/migrations.test.ts` | 14 | migrations on a real PostgreSQL (below), including the `admin_setup` marker |
| `tests/integration/crawl.test.ts` | 32 | full public crawls of a local multi-feature site (scenario table below) |
| `tests/integration/storage.test.ts` | 15 | local and S3 archive stores (below) |
| `tests/integration/authenticated-crawl.test.ts` | 4 | form login, separate archives per profile, isolation, wrong password, redaction, mid-crawl reauthentication |
| `tests/integration/authenticated-v31.test.ts` | 15 | protected assets, API/GraphQL discovery, manual sign-in, MFA, session reuse/expiry, combined discovery |
| `tests/integration/saved-login-profiles.test.ts` | 18 | reusable logins against real PostgreSQL + real Chromium + a real `CrawlWorker`: metadata-only creation, same-site rule, ownership 404s, cookie scoping, encrypted-at-rest, “Login with Browser” (real isolated browser, hand sign-in, refusal before signing in, JPEG frames, abandoned window), attaching to a crawl (per-crawl profile, no second login, authenticated ZIP), no-worker honesty, request-capture import, housekeeping |
| `tests/e2e/browser.test.ts` | 9 | JS rendering, SPA, lazy loading, full-mode interaction, render guard, offline click-through, visual comparison |
| `tests/e2e/api.test.ts` | 21 | the production server over HTTP + SSE: accounts, CSRF, ownership, crawls, signed-in crawls |
| `tests/e2e/worker.test.ts` | 9 | web tier and worker as separate processes: queue, object storage, shutdown, crash, restart, retention |
| `tests/e2e/ui.test.ts` | 7 | the web UI driven in a real browser (per-crawl login form, MFA panel, ZIP), plus the embedding headers |
| `tests/e2e/saved-login-ui.test.ts` | 8 | the whole saved-login workflow in the production build driven in a browser: address → “Login with Browser” → real isolated browser → hand sign-in → “Use This Login” → “Login profile saved” → attached to the crawl → authenticated ZIP; refusal before signing in; no session material in the page or the database; site scoping (foreign profile disabled **and** refused by the API with no job created); 390 px Android layout with no horizontal overflow and ≥ 40 px touch targets; forgetting a login; deleting a profile |
| `tests/unit/setup.test.ts` | 8 | `ADMIN_SETUP_KEY` rules (missing, short, low-entropy, placeholder, timing-safe match), administrator password policy, setup status vocabulary |
| `tests/e2e/setup-admin.test.ts` | 19 | one-time first-administrator setup against the production server: disabled without a usable key, wrong key, invalid email, weak password, mismatched confirmation, cross-origin/cross-site/form posts, rate limits, creation, scrypt storage, `409` afterwards, advisory-lock race, sign-in, admin-only route, ordinary accounts unaffected, key never logged, and the page in an Android viewport |
| `tests/live/live.test.ts` | 2 skipped | opt-in (`LIVE=1`), needs internet; **not run in this pass** |

### First-administrator setup (V3.1.1)

`tests/e2e/setup-admin.test.ts` boots the production build against real PostgreSQL servers and drives the
requirement checklist end to end:

| # | Requirement | Result |
|---|---|---|
| 1 | Setup page loads on mobile (412×915, Android UA) | pass — no horizontal overflow, all fields ≥ 36 px tall, show/hide works, hints and inline errors render, no console errors |
| 2 | Setup disabled without a valid secret | pass — missing key: `state: "not-configured"`, page shows "Setup is not available", `POST` → `503`; short key → `key-too-weak` + `503` |
| 3 | Incorrect setup key rejected | pass — `403`, nothing written |
| 4 | Invalid email rejected | pass — `400` for `not-an-email`, `a@b`, spaces, empty, non-string |
| 5 | Weak password rejected | pass — `400` with the policy message for short, single-class and email-derived passwords |
| 6 | Confirmation mismatch rejected | pass — `400` |
| 7 | First admin created | pass — `201`, `role = admin`, marker row written |
| 8 | Password hashed | pass — `scrypt$32768$8$1$…`, never the plaintext, in the database or the response |
| 9 | Duplicate email rejected | pass — `409` when a `user` row already holds the address; setup still available afterwards |
| 10 | Second admin rejected | pass — `409` after creation, and a `201`/`409` split under two simultaneous submissions (advisory lock) |
| 11 | Login works after setup | pass — `POST /api/auth/login` → session cookie + CSRF, `/api/auth/me` reports the admin |
| 12 | Admin-only routes work | pass — `/api/admin/overview` `200` for the admin, `403` for `role = user`, `401` anonymous |
| 13 | Existing authentication unaffected | pass — an ordinary account signs in and uses `/api/crawl` exactly as before; the whole existing suite is unchanged and green |
| 14 | Production build passes | pass — `next build`, `tsc --noEmit`, `eslint .` clean |
| 15 | No secrets in bundles or logs | pass — `ADMIN_SETUP_KEY`, `scrypt`, `timingSafeEqual` and `pg_advisory` appear in **no** `.next/static` file; server output contains neither the key nor the password |

## Reusable “Login with Browser” profiles

| # | Requirement | Where | Result |
|---|---|---|---|
| 1 | URL validation before anything starts | `tests/e2e/saved-login-ui.test.ts`, unit `normalizeAddress` | pass — empty, `ftp:`, `file:`, credentials in the URL, non-addresses are refused with a message; the field is `aria-invalid` with a described error |
| 2 | The real site opens in an isolated browser | integration + e2e | pass — the worker launches its own Chromium context, the panel shows a real JPEG of the fixture's `/login`, the page address is shown origin+path only |
| 3 | Manual, multi-page login | integration (keyboard only), e2e (Tab/type/Tab/type/Enter) | pass — nothing is pre-filled; the site receives exactly one `POST /login`, from the user's own keystrokes |
| 4 | “Use This Login” validates before saving | integration + e2e | pass — refused while still on the form (“The browser is still on the login page”); accepted once the dashboard is up |
| 5 | Profile saved and reported | integration + e2e | pass — “Login profile saved”, status `active`, one session row, `v2.` envelope |
| 6 | Selecting a profile for a crawl | e2e | pass — checkbox attaches it; the crawl starts with `attachedProfiles: ["Member account"]` |
| 7 | Crawl uses the authenticated context | integration + e2e | pass — “Restored the saved login profile”, `dashboard/index.html` in the ZIP contains `Account member@example.test`, no second sign-in |
| 8 | Profile ↔ domain binding | unit + integration + e2e | pass — foreign site: checkbox disabled, “Not for this address”, API answers 400 and creates no job; a subdomain needs `matchSubdomains`; a different port is a different site |
| 9 | Session expiry and re-login | integration | pass — `invalidateSavedSession` → `session-expired` + “sign in again”; anonymised session → `session-rejected`; the profile row is never deleted |
| 10 | Unauthorized access rejected | integration | pass — another owner gets an identical 404 from every operation (read, rename, attach, clear, delete, open a window) |
| 11 | Session isolation between users | integration + e2e | pass — foreign cookies are dropped on capture; the sealed envelope is bound to owner+profile+host, so moving the row makes it undecryptable |
| 12 | No secrets in logs, responses or pages | integration + e2e | pass — neither the password nor the username appears in `target_login_profiles`, `login_sessions`, `login_profile_commands`, the rendered page, the server output or the ZIP; cookie values never leave the server |
| 13 | Worker-offline honesty | integration | pass — job stays `queued`, `workerOnline: false`, the profile keeps its session and status, the UI offers a recovery message |
| 14 | Mobile layout | e2e (390×844, `isMobile`) | pass — `scrollWidth <= clientWidth`, primary buttons ≥ 40 px tall, screenshot attached to the run |
| 15 | Existing login and crawler behaviour | full suites | pass — 142 unit+db, 84 integration and 73 e2e tests green, including the per-crawl form login, MFA panel, ownership, quotas and the worker/crash tests |

Two product fixes came out of this work and are covered above: the sign-in window used to show nothing when
“Use This Login” was refused (the message is now polled and displayed), and the panel compared hostnames without the
port, so a login saved for one local site was offered for another on a different port.

## What the new suites establish

### Database (`tests/db`)
* An empty database gets the full schema (9 tables + `schema_migrations`); a second run applies nothing.
* The migrated columns and their NOT NULL flags match `src/db/schema.ts` table by table — the SQL files and the ORM
  schema cannot drift apart unnoticed.
* A database in the exact shape version 3.0 created, **containing a row**, upgrades in place; the row survives with
  `owner_id NULL` (and is therefore visible to nobody — asserted at the API as well).
* Three migrations started at the same moment apply each file once.
* A migration that fails half-way is rolled back completely, reported with its file name, and applies cleanly once fixed.
* `npm run db:migrate` and `npm run user:create` behave as commands (exit codes, duplicate account, weak password,
  unreachable database; the password is never echoed; the stored hash is scrypt). They read `.env`; real environment
  variables win. `package.json` is asserted to run exactly the command line the tests use.
* Constraints: case-insensitive unique email, foreign keys, cascades (deleting a job or a user leaves no profile,
  session, command or event row behind).
* The queue claim statement, issued by 8 competing connections against 20 queued jobs, hands out each job exactly once.

### Archive storage (`tests/integration/storage.test.ts`)
* The same contract runs against both stores: byte-identical round-trip, delete, `move` semantics, refusal of keys
  that could escape (`..`, absolute, spaces, empty) before any request is made.
* **Signature V4 correctness, two independent ways.** (1) Pre-signed URLs produced by the built-in signer are compared,
  character for character, with the output of AWS's own signer (`@smithy/signature-v4`, the library inside the AWS SDK
  v3) for path-style and virtual-hosted addressing. (2) Every request the store sends goes through a gate that
  recomputes the signature with that AWS library and answers 403 if it differs; the S3 test server behind it is never
  reachable directly. This was necessary because `s3rver` on its own accepts any signature.
* Anonymous, tampered, wrong-key and expired requests are refused (403); a pre-signed link stops working after its
  lifetime; wrong secret / access key / region fail the start-up check with HTTP 403, a missing bucket with 404.
* Uploads survive a short outage — two consecutive `503`, `429` or dropped connections are retried and the third
  attempt stores the object; a lasting outage fails after exactly three attempts and keeps the source file; a `403`
  is sent once and not retried.

This proves the request signing against AWS's reference implementation. It does **not** prove behaviour against a real
provider (bucket policies, regional redirects, provider-specific limits, TLS).

### Web tier + worker as separate processes (`tests/e2e/worker.test.ts`)
* A web tier with **no browser available** and no worker reports `{ok: true, worker: "offline"}`, keeps jobs `queued`,
  never contacts the target site, answers 501 on the login self-test, can cancel and delete a queued job, and writes no
  job directory.
* A worker refuses to start without `DATABASE_URL`, and exits with `object storage upload failed: HTTP 403` on a wrong
  S3 secret. It logs the Chromium version it found; `/healthz` answers 200.
* A queued job is claimed, crawled and uploaded: the row records `storage: "s3"` and the object key, the worker's
  scratch directory is gone, and the download route answers `302` (`no-store`) to a pre-signed link with
  `X-Amz-Expires=60`. The downloaded bytes match the recorded SHA-256 and entry count. Another user gets 404; the bare
  bucket URL gets 403; deleting the job removes the objects.
* **SIGTERM**: the worker exits 0 after logging that it saves running crawls; the job is `interrupted`. A new worker
  does not resume it by itself. After the owner resumes, it completes, and pages finished before the shutdown were
  requested exactly once.
* **SIGKILL**: the row stays `running` on the dead worker until another worker notices the stale heartbeat
  (`WORKER_STALE_SECONDS=15` in the test) and marks it `interrupted`; resume then completes all 21 pages.
* A signed-in crawl interrupted by a restart: password and session are `v2.` envelopes in the database the whole time,
  the new worker logs “Restored the saved browser session”, the site sees **no second login**, both secrets are wiped
  at the end, and the password appears in no process output.
* Two workers, six jobs: each job was held by exactly one worker, both workers did work, each page was fetched once and
  each job packaged once.
* A resumed job picked up by a worker with an empty scratch disk starts over, says so in its log, and still completes.
* Retention: a starting worker deletes a two-day-old ended crawl — row, events, archive and reports in the bucket — and
  an orphaned scratch directory, while a recent crawl, its archive and its directory stay.

One defect surfaced here and is fixed: started through the `tsx` command-line wrapper, the worker ran as a child
process and never received the signal — it kept crawling after “stop”. All entry points now run as a single process.

### HTTP API (`tests/e2e/api.test.ts`)
Accounts and sessions (cookie flags, only the token's hash stored, identical answers for wrong password and unknown
account, rate limiting, registration modes, CSRF token **and** origin, logout), input validation (permission
confirmation, private/metadata/non-http targets refused by a default-configured server, malformed ids), a full crawl
with live events, reconnect via `Last-Event-ID`, ZIP + checksum + reports, pause/resume/cancel, per-user job limit,
**ownership on every route** (a second user gets 404 for status, events, ZIP, reports, control, credentials, sign-in
sessions, frames and input), and signed-in crawls end to end: credentials only ever stored encrypted and never
returned, wiped at the end and on failure; manual sign-in through frames and forwarded input including a one-time
code; clearing credentials mid-sign-in; combined discovery with the access matrix; the login self-test leaking nothing.

### Web UI in a browser (`tests/e2e/ui.test.ts`)
A visitor sees only the sign-in form. Then, clicking and typing like a user: wrong password rejected, account created,
sign-in (cookie is HttpOnly and invisible to page scripts), start refused without the permission checkbox, a login
profile filled in, the crawl started — the password field empties and the password is no longer anywhere in the page —
the site's one-time-code step appears in the remote sign-in panel as a real 1280×800 frame, the job shows “waiting for
sign-in” with no Resume button, a wrong code typed on the keyboard is rejected by the site, the right one entered
through the text box lets the crawl continue to “completed”, the ZIP is downloaded through the browser and contains
the signed-in page, the stored secrets are gone from the database; history survives a reload; a report opens; delete
removes the job; sign-out removes the session. Throughout, the page logged no console error, no uncaught exception and
no unexpected 4xx/5xx response. A second server checks `APP_EMBED_ORIGINS`: default `DENY` / `frame-ancestors 'none'`;
with an allow-list only valid origins appear and the cookie becomes `__Host-…; Secure; SameSite=None; Partitioned`.

Not covered by the UI test: the advanced-settings panel, pause/resume/cancel buttons, the multi-profile and combined
controls, the interrupted-crawl Resume button (these paths are tested through the API, not by clicking), narrow/mobile
layouts, accessibility, and any browser other than Chromium.

### Signed-in crawling (`tests/integration/authenticated-*.test.ts`)
Against a test-owned site with cookie sessions, a one-time-code step, role-specific pages, protected assets, JSON and
GraphQL APIs and endpoints that count destructive hits: protected images/CSS/fonts/SVG/backgrounds/lazy and responsive
images downloaded with the session and rewritten; API calls recorded, JSON redacted, pagination followed with GET,
authorised GraphQL queries only, **every state-changing request blocked** (the site's counters stay at zero); manual
sign-in handed to the user, with timeout; MFA pause without answering it, and fail-closed without an MFA selector;
session restore, invalid restored session, expiry mid-crawl with the interrupted page kept, manual reauthentication;
combined discovery with isolation between accounts and a failing profile not affecting the others.

## Public crawling: the 18 scenarios (`tests/integration/crawl.test.ts`, `tests/e2e/browser.test.ts`)

| # | Scenario | Result |
|---|---|---|
| 1 | Simple multi-page site | pass (≥ 20 pages from one URL) |
| 2 | Deep nested routes (4 levels) | pass |
| 3 | Query-parameter URLs, tracking params stripped, order-insensitive | pass |
| 4 | Pagination, endless-pagination and calendar traps capped | pass |
| 5 | Sitemap discovery (index → nested; pages linked from nowhere) | pass |
| 6 | JavaScript-rendered links (fast mode misses them, JS mode finds them) | pass |
| 7 | SPA navigation (pushState routes) + offline SPA copy | pass |
| 8 | Lazy-loaded images (`data-src`; IntersectionObserver below the fold) | pass |
| 9 | CSS backgrounds, `@import`, inline styles | pass |
| 10 | Fonts downloaded and rewritten | pass for download + rewrite; fixture fonts are dummy bytes, rendering not verified |
| 11 | Duplicate assets by content hash | pass |
| 12 | Offline link rewriting; browser click-through with all http(s) blocked: 0 requests, 0 page errors | pass |
| 13 | ZIP integrity and entry-name safety | pass |
| 14 | Failed-request recovery (500→OK, 429 + `Retry-After`, permanent failure reported with attempts) | pass |
| 15 | Cancellation with a valid partial ZIP; pause/resume | pass |
| 16 | SSRF protection (51 unit tests + crawler, API and browser-guard level) | pass |
| 17 | Domain boundary (the external server received 0 requests) | pass |
| 18 | Resource quotas (total size, per-file cap while streaming, pages, depth, wall clock) | pass |

Visual comparison on the fixture `/about` page: 0.000 % pixel mismatch at desktop, tablet and mobile sizes. This shows
the pipeline works on a trivial page (a second test proves it flags resources missing offline); it is **not** evidence
of fidelity on real-world sites.

## Defects found by testing in this pass (all fixed, each now covered by a test)

1. **Worker ignored SIGTERM/SIGKILL** when started through the `tsx` wrapper (signals hit the wrapper only).
2. **Reauthentication could stall**: session expiry was judged from a 15-second-old cached probe. It now always probes.
3. **Report said `running` and doubled the duration** for finished crawls (reports were written before the final
   status and the clock segment was counted twice).
4. **Security headers set globally replaced the report route's own sandbox policy.** Page headers now apply to pages only.
5. **Two servers with different network policies on one database** took each other's jobs and failed them. Documented
   as a deployment rule; the tests give such servers separate databases.
6. **SVG `<image href>` / `<use href>`** references were not rewritten.
7. **GraphQL records with the same URL overwrote each other** in the API report.
8. **Sign-in panel**: keystrokes were sent as parallel requests and could arrive out of order (now one ordered,
   batched stream); the panel requested one more frame after the sign-in ended and logged a 404 (the route now answers
   204 to the owner); the page URL shown in the panel did not update.
9. **UI**: a crawl waiting for a person showed “paused” with a Resume button; resuming an interrupted crawl did not
   reconnect the live view; `queued` had no status style; anonymous page loads logged a 401 from `/api/auth/me`.
10. **Upload retry** (added in this pass) initially also retried invalid-key errors; caught by the storage contract test.
11. A resumed crawl claimed by a worker without the saved state **failed**; it now starts over and says so.

Several first-run failures were wrong expectations in new tests (for example a log line that does not exist, or the
depth ceiling of 20); those were corrected in the tests and are not listed as product defects.

## Not tested

* **Playwright's own Chromium 158**, and any browser other than Chromium 153.
* **Real infrastructure**: no deployment to Vercel; no managed PostgreSQL (pooling, TLS, failover); no AWS S3,
  Cloudflare R2 or MinIO; no container build (no Docker in the sandbox — the Dockerfile in DEPLOYMENT.md is unbuilt).
* **Third-party sign-in**: no Google/Microsoft/Okta/Auth0 login, no real CAPTCHA, no passkeys, no popup-based flow.
  The sign-in fixtures are test-owned sites.
* **The public internet**: the opt-in live test was not run in this pass; all sites were local fixtures on loopback
  (which is why the test servers run with `CRAWLER_ALLOW_PRIVATE_NETWORKS=1`; the strict default is tested separately).
* **Load and endurance**: no crawl beyond a few dozen pages, no memory profile, no long-running worker, no many-user
  or many-viewer test. The concurrency tests use 2 workers and 6 jobs.
* **Database outage during a crawl**, a network partition between worker and database, and a worker's disk filling up.
* Saved-session expiry by TTL (`CRAWLER_SESSION_TTL_HOURS`) was not exercised by a test.
* HTTPS/TLS error paths, subdomain crawling with real DNS names, Windows/macOS extraction of the generated paths.
* **Hostless Cloud, Vercel, container registries and cloud buckets**: no deployment was performed. The worker build and
  start commands documented in [DEPLOYMENT.md](DEPLOYMENT.md) were verified locally (clean `npm ci`, `npm run
  typecheck`, `npm run build`, `npm run worker` against a real PostgreSQL, `GET /healthz` → `200`, clean `SIGTERM`
  shutdown), not on the platforms themselves.
* No security review or penetration test by anyone other than the author.

## Reproduce

```bash
npm ci                   # Node 22 / npm 11; installs the committed lockfile
npm run typecheck && npm run lint
npm run build            # the e2e suites drive the production build
npm test                 # ≈ 9 minutes; starts its own PostgreSQL and S3 test servers; needs a Chromium (see above)
```
