# Limitations (honest list)

**Fidelity is not 100% and was never measured as such.** The visual comparison reports differences per page and viewport;
its only measured results so far are on a tiny local fixture page (0.000 % difference — which says nothing about complex sites).

## Cannot work offline / not archived
* Forms (search, comments, checkout), server-side logic, live APIs (`fetch`/XHR endpoints are *listed* in the report, not
  archived), WebSockets, payments. Non-GET browser requests are blocked except for explicitly configured login-phase form POSTs.
* Paywalls, CAPTCHAs, MFA and IP/geo restrictions are never bypassed. See [authenticated crawling scope](AUTHENTICATED-CRAWLING.md):
  automated form login is opt-in, but manual browser/MFA login and authenticated assets/XHR remain unsupported.
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
* Chromium requires system libraries. Where it cannot start the crawler falls back to Fast mode (recorded in the log and the
  report). In the development sandbox the libraries had to be unpacked manually to run the browser tests; the preview server
  of that sandbox does not have them, so JS/Full modes fall back to Fast there.

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
* Resume after a server restart restores from the last snapshot (≤ ~3 s old); verified by a snapshot-copy test, **not** by
  killing the process. In-flight pages at the time of the crash are re-fetched.
* Socket.IO from the original project was replaced by Server-Sent Events (one-way is sufficient; control uses POST).
* The job manager lives in the Node process: running crawls are not shared across multiple server instances.

## Visual comparison
Needs Chromium; compares full-page screenshots pixel-by-pixel (threshold 0.1) after cropping to the common size and reports
the dimension difference. Dynamic content (ads, carousels, time) will register as differences. Limited to `visualMaxPages`
(default 3) pages × 3 viewports; screenshot height capped at 6000 px.
