# Architecture audit of the original repository

Repository audited: `https://github.com/AhmadIbrahiim/Website-downloader` (cloned and read in full: `app.js`, `bin/www`,
`routes/`, `socket/socket.js`, `wget/index.js`, `archiver/index.js`, `views/index.hbs`, `package.json`).
Everything below comes from reading that code. Statements about *why* a site is limited are analysis of `wget`'s documented
behaviour, **not** measurements — the original app was not executed against live sites.

## 1. How the original works

```
Browser (hbs page + socket.io-client)
   │  emit("request", {token, website})
   ▼
socket/socket.js  ── one job per socket; cancel() on disconnect
   ▼
wget/index.js     ── execFile("wget", ["-mkEpnp", "--no-if-modified-since", "--quota=100m", url]) in downloads/<jobId>
   │                 stderr lines are forwarded to the browser as "progress" text
   ▼
archiver/index.js ── archiver zip level 9 → public/sites/<host>-<jobId>.zip, served statically
```

Express 4 (`app.js`) renders a single Handlebars page; `bin/www` creates the HTTP server and attaches Socket.IO 2.x.
There is **no authentication**, no database and no user model — so none was preserved or added.

## 2. Why only the homepage / a limited set of pages is downloaded

`wget -m -k -E -p -np` is a link-following mirror tool, not a browser. Consequences (from wget's documentation and the
flags used):

1. **No JavaScript.** Links, images and routes created by React/Vue/Angular/Next/Nuxt/Svelte never exist in the HTML wget
   parses, so SPA sites yield a shell page.
2. **Navigation is HTML-only.** Pagination or filters triggered by script, buttons, `pushState` are invisible.
3. **No sitemap discovery.** `sitemap.xml` is not read; pages that are not linked from other pages are never found.
4. **Query-string handling is incidental.** Query URLs are fetched when linked, but mapped to file names containing `?`
   (problematic on Windows/ZIP extractors), with no normalisation, no tracking-parameter removal and no trap protection.
5. **`robots.txt` is honoured by `--mirror`** with no visibility for the user: a restrictive robots file can silently end the
   crawl after the first page ("nothing downloaded" is only detected by counting files).
6. **`-np` (no-parent)** limits recursion to the start path's subtree; start at `/blog/` and `/about` is never visited.
7. **`--quota=100m` and the 5-minute timeout** (both overridable by env) terminate the process abruptly. `--convert-links`
   runs *after* the mirror finishes, so a killed run leaves absolute links in the files.
8. **Default recursion depth** of `--mirror` is infinite but bounded only by the quota — there is no page limit, no depth
   control and no trap detection (calendars, endless `?page=N`).
9. **Progress is raw wget stderr**, so there are no real statistics (pages found/remaining, failures, duplicates).

## 3. Bugs / risks found

| # | Finding | Severity | Status in this upgrade |
|---|---|---|---|
| 1 | **No SSRF protection.** wget will happily fetch `http://169.254.169.254/`, `localhost`, private ranges, and follows redirects to them. | High | Replaced by a guarded HTTP layer (docs/SECURITY.md) |
| 2 | One job per *socket connection*; reconnecting loses the job; no pause/resume; cancel only on disconnect. | Medium | Server-side job manager, Pause/Resume/Cancel API |
| 3 | No per-user/IP rate limit or global concurrency limit → trivial resource exhaustion. | Medium | Per-IP start limit, max concurrent jobs, storage quota |
| 4 | Disk exhaustion: quota only on wget output; ZIPs in `public/sites` never deleted. | Medium | Per-file/total/ hard quotas; retention cleanup (24 h); delete API |
| 5 | ZIP is created with `archive.directory()`; wget file names come from remote URLs. | Low | Own walker validates every entry name, skips symlinks |
| 6 | Output served from `public/` (static, guessable names). | Low | Download goes through an API route, IDs are validated (`^[a-f0-9]{16}$`) |
| 7 | Socket.IO 2.x / archiver 3.x / old Express are outdated dependencies. | Low | Not carried over (see §4) |

The original already had hardening commits worth recognising (use of `execFile` instead of a shell, per-job directories,
guarded `removeJobDir`, error callbacks instead of throws in the archiver). Those *ideas* were kept: per-job directories,
guarded deletion (`safeJoin`), errors reported to the client instead of crashing the process.

## 4. What was ported vs replaced — read this

The workspace this upgrade was performed in is a **Next.js (App Router) + PostgreSQL/Drizzle project**, not a checkout of the
Express repository. Therefore the upgrade was implemented as a TypeScript module inside this Next.js app instead of
patching the Express files in place. Be explicit about the mapping:

| Original | Here | Notes |
|---|---|---|
| Express + hbs UI | Next.js page + React dashboard | UI redesigned, same workflow (URL → live progress → ZIP) |
| Socket.IO | **Server-Sent Events** (`/api/crawl/:id/events`) | Same real-time semantics; chosen because SSE works in the platform's Next.js runtime without a custom server. Socket.IO could be added with a custom server if required. |
| `wget -mkEpnp` | Own crawler engine (`src/lib/crawler`) | `wget` is **not used** any more: it cannot satisfy discovery, JS rendering, SSRF and query requirements. |
| `archiver` ZIP | `archiver` 8 (same library, upgraded) | Streamed entry by entry |
| Download folder per job | `CRAWL_DATA_DIR/<id>` | Same idea |
| In-memory only | PostgreSQL `crawl_jobs` history table | Needed for history and interrupted-job detection |

## 5. Implementation plan (executed)

1. Security primitives first (`security.ts`, `http.ts`): SSRF, redirects, size/time limits, retries.
2. URL layer (`url.ts`): normalisation, scope, traps, local path mapping, collision-free registry.
3. Parsing (`parser.ts`, `robots.ts`): HTML/CSS/srcset/JS extraction and *shared* rewriting table.
4. Engine (`engine.ts`) + asset manager (`assets.ts`) + renderer (`renderer.ts`).
5. Rewrite phase, reports, ZIP, visual comparison.
6. Job manager, API, UI.
7. Tests against local fixture sites + real browser; fix what they uncover (several real bugs were found this way, see
   TESTING-REPORT.md); documentation.
