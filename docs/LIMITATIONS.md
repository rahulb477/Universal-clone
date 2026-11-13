# Limitations (honest list)

**Fidelity is not 100% and was never measured as such.** The visual comparison reports differences per page and viewport;
its only measured results so far are on a tiny local fixture page (0.000 % difference — which says nothing about complex sites).

## Cannot work offline / not archived
* Forms (search, comments, checkout), server-side logic, WebSockets, payments. Live APIs do not work offline:
  `fetch`/XHR calls are listed in `_report/api-discovery.json` (optionally with redacted JSON bodies of GET responses),
  but the offline pages are not rewired to read them. Non-GET browser requests are blocked except sign-in form posts.
* Paywalls, CAPTCHAs, MFA and IP/geo restrictions are never bypassed. A person can answer a site's sign-in challenge in
  the remote sign-in window; what that window cannot do is listed in [AUTHENTICATED-CRAWLING.md](AUTHENTICATED-CRAWLING.md).
* Hash-routed SPAs (`/#/page`): fragments are dropped, so those routes are not discovered.
* Service workers/PWA offline logic (blocked during rendering).

## JavaScript handling
* **JS mode** saves a *rendered snapshot* with scripts removed: layout and content are preserved, interactivity (menus,
  carousels, tabs driven by JS, live data) is static.
* **Full mode** keeps scripts, but they run from `file://` without the origin server: client routers, runtime `fetch`, module
  loading restrictions of `file://` and runtime-built asset URLs can break. It is "best effort", not a guarantee.
* JavaScript files are never rewritten. Asset URLs found as string literals are downloaded to a path mirroring the original
  *root-relative* path; code that builds URLs dynamically may still hit the live site.
* CSS-in-JS rules living only in the CSSOM are materialised into `<style>` text when possible; constructed/adopted
  stylesheets and shadow-DOM styles are not captured. `<canvas>`, WebGL and video streams are not captured.
* Chromium requires system libraries. Where it cannot start, public crawls fall back to Fast mode (recorded in the log
  and the report) and signed-in crawls fail; a worker refuses to start without a working browser unless
  `WORKER_ALLOW_NO_BROWSER=1`.

## Crawl behaviour
* Pages with byte-identical content under different URLs are merged into one (aliases); this is intentional but means a page
  that *intentionally* has duplicates is stored once.
* Identical asset content is stored once; JS that references the second path directly will not find it.
* Search results and filter combinations are only discovered when linked, and bounded (30 variants per path, 3 parameters).
* `robots.txt` is applied to pages, not to sub-resources. Sitemaps on other hosts are ignored.
* Trap detection is heuristic; unusual infinite URL spaces are still bounded by `maxPages`, `maxDepth`, size and time limits.

## Performance / architecture
* Responses are buffered in memory up to the per-file cap (default 25 MB) — downloads are *capped while streaming*, but are
  not streamed to disk. With 8 workers and 200 MB caps memory use can be high; keep caps modest.
* The ZIP is built after the crawl from files on disk (entry by entry, no whole-site buffering) — it is not "incremental"
  during the crawl.
* Resume after a worker shutdown or crash restores from the last snapshot (≤ ~3 s old); verified by terminating and
  killing real worker processes. In-flight pages are re-fetched. The snapshot lives on that worker's disk: if the
  resumed job is picked up by a worker that does not have it (another machine, wiped disk), the crawl **starts over**
  and says so in its log. A combined-discovery crawl always starts over after an interruption.
* An interrupted crawl is never resumed automatically; its owner has to press Resume.
* Jobs are claimed oldest-first with no per-user fairness or priorities: one user with many queued crawls delays others
  (bounded by `CRAWLER_MAX_ACTIVE_JOBS_PER_USER`).
* Live updates are delivered by polling PostgreSQL (every 0.7 s per open stream); many simultaneous viewers mean many
  small queries. When a crawl ends only its last 500 log lines are kept; the full detail is in the report files.
* S3 uploads are single PUT requests (no multipart): the archive size is limited by the provider's single-object PUT
  limit. A failed upload is retried as a whole, three attempts in total; if the store stays unreachable the crawl ends
  as failed (“The archive was created but could not be stored”) and has to be run again.
* With local storage the web app and the worker must share a directory; on separate machines use S3-compatible storage.
* Socket.IO from the original project was replaced by Server-Sent Events (one-way is sufficient; control uses POST).

## Saved logins ("Login with Browser")
* A saved login is a **cookie/storage snapshot**, not a live browser. Sites that rotate a token on every request, bind a
  session to a device/TLS fingerprint, or keep server-side state tied to an IP can reject it. Some accept it only from
  the same network as the worker.
* The window is a picture with about one frame per second: no drag-and-drop, file upload, clipboard, multi-touch or
  WebAuthn/passkey prompts. Some CAPTCHA styles are therefore not answerable, and a one-time code has to be typed.
* A window closes after `CRAWLER_LOGIN_BROWSER_MINUTES` (15 by default) and after 90 s with no activity; a slow
  federated sign-in can run out of time, which costs one retry.
* One profile is one site: a login used across several related hostnames needs `matchSubdomains` and a consistent
  cookie domain — a session cookie set for `auth.example.com` and used on `app.example.com` only works if the site
  itself set it for `.example.com`.
* Reusing a saved login keeps it alive only as long as the site allows. Nothing refreshes a token proactively, and there
  is no scheduled re-crawl: when the site rejects it the profile shows "session rejected" and you sign in again.
* Profiles are per account. There is no sharing, no team scope and no admin view of another user's saved logins.
* The import-a-request fallback accepts cookies copied from a browser; a site that needs more than cookies (a signed
  header, a device certificate) is out of scope.

## Accounts
* Email + password only. No email verification, password reset, second factor, single sign-on or admin screen; an
  operator creates accounts on the command line (or enables invite/open registration).
* No teams or sharing: a crawl is visible to exactly one account.

## Not exercised in production-like infrastructure
The split deployment was tested on one machine with real processes, a real PostgreSQL server and an S3 API test server.
It has not been deployed to Vercel, run against a managed PostgreSQL service, or pointed at AWS S3 / Cloudflare R2 /
MinIO; no load or soak test was performed. See [TESTING-REPORT.md](TESTING-REPORT.md).

## Visual comparison
Needs Chromium; compares full-page screenshots pixel-by-pixel (threshold 0.1) after cropping to the common size and reports
the dimension difference. Dynamic content (ads, carousels, time) will register as differences. Limited to `visualMaxPages`
(default 3) pages × 3 viewports; screenshot height capped at 6000 px.
