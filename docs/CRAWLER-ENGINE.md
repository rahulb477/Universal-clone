# Crawler engine

`src/lib/crawler/engine.ts` — class `Crawler extends EventEmitter`.

```ts
const c = new Crawler(url, options, { workDir, allowPrivateNetworks?, resume? });
c.on("log", e => …); c.on("stats", s => …); c.on("status", s => …);
const result = await c.run();       // { status, zipPath, reportDir, stats, error? }
c.pause(); c.resumeCrawl(); c.cancel();
```

## Lifecycle

1. **Validate** the start URL (`assertPublicUrl`: scheme, credentials, private/metadata addresses, DNS).
2. **Scope** is created from the start URL (host without `www.`, port, optional subdomains/path prefix, include/exclude).
3. **Resume?** If `resume` and `state.json` exist, queue/visited/pages/assets are restored; otherwise seed the queue.
4. **Renderer** (if mode ≠ fast or visual comparison): launch Chromium; if it fails, fall back to fast mode and say so.
5. **Sitemaps**: `robots.txt` `Sitemap:` lines + `/sitemap.xml` + `/sitemap_index.xml`; nested indexes (≤ 25 files);
   URLs enter the queue at depth 1.
6. **Workers** loop: gate (pause) → limit check (time/size) → pop → `processPage`.
7. **Finalise**: leftover queue items → "skipped"; rewrite pages and CSS; offline helpers; optional visual comparison;
   reports; ZIP; delete `raw/` and `site/`.

## processPage

1. robots check (pages on the same origin; `Crawl-delay` honoured).
2. `fetchUrl`: semaphore → host throttle → `fetchWithRetry` (redirect validation: after depth 0 a redirect must stay in scope).
3. HTTP status ≥ 400 → failure record (`404`, `403`, `500` …); **404/403 are never retried**; 408/425/429/5xx and network
   timeouts are retried with exponential backoff (`retryBaseMs · 2^n` + jitter, `Retry-After` honoured, cap 30 s).
4. Non-HTML response for a page URL (PDF, image, API) → stored as an asset.
5. HTML decoded using the header/`<meta>` charset. In JS/Full mode Chromium renders the URL (waits for network idle and a
   stable DOM, scrolls to trigger lazy loading, Full mode clicks safe "load more" controls) and the **rendered DOM** replaces
   the static HTML. A render failure falls back to the static HTML and is recorded.
6. **Redirect aliasing** (`/redirect → /team`) and **content-hash dedupe** (identical HTML under another URL becomes an alias,
   and its links are not followed again — this is also what neutralises many query-parameter traps).
7. Links → `consider()` (see URL-DISCOVERY.md); assets → `AssetManager.download()` (6 in parallel per page).
8. Raw HTML written to disk; page registered with a collision-free local path.

## States

`idle → running ⇄ paused → completed | cancelled | failed`. `interrupted` means the worker stopped while the crawl was
running — set by the worker itself on a graceful shutdown, or by another worker when the heartbeat goes stale. (The
job row additionally has `queued` before a worker claims it.) Waiting for a person to sign in counts as `paused`. `completed` may carry a `stopReason` (time limit, total size limit) — the archive is then
explicitly partial.

## Stats (all real counters)

`pagesDiscovered`, `pagesCrawled`, `pagesRemaining` (= queued + in flight), `pagesFailed`, `pagesSkipped`, `assetsDiscovered`,
`assetsDownloaded`, `assetsFailed`, `duplicateUrls`, `duplicateAssets`, `externalLinks`, `currentUrls`, `bytesDownloaded`,
`speedBps` (5 s sliding window), `maxDepthReached`, `elapsedMs` (excludes paused time) and `progress = (crawled + failed) /
(crawled + failed + remaining)`. The UI labels it as "N of M known pages" because M can still grow while link discovery
continues — there is no fabricated percentage.

## Pause / resume / cancel / recovery

* **Pause**: workers stop taking new URLs; in-flight pages finish. **Resume** releases the gate.
* **Cancel**: aborts all in-flight requests (`AbortController`), returns unfinished items to the queue, then finalises and
  packages what exists (`status: cancelled`, usable ZIP).
* **Snapshots**: `state.json` is written at most every ~3 s, on finalise and when the worker is told to stop
  (`suspend()`). Resuming an *interrupted* job continues from it; finished pages are not fetched again. Verified by
  sending SIGTERM and SIGKILL to real worker processes (TESTING-REPORT.md). If the snapshot is not on the worker that
  picks the job up, the crawl starts over.
* **Signed-in crawls** additionally keep the browser session (encrypted, in the database), probe the signed-in state
  when a page answers 401/403 or bounces to the login page, and pause for reauthentication when the probe fails. Time
  spent waiting for a person is not counted against the wall-clock limit. See AUTHENTICATED-CRAWLING.md.

## Limits (all clamped server-side)

depth ≤ 20, pages ≤ 5000, concurrency ≤ 8, per-file ≤ 200 MB, total ≤ 2 GiB, retries ≤ 6, wall clock ≤ 2 h,
request timeout ≤ 60 s. Defaults are far lower (depth 5, 200 pages, 25 MB / 500 MB, 30 min).
