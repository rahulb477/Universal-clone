# Asset downloader

`assets.ts` (`AssetManager`) + extraction in `parser.ts`.

## What is inspected

| Source | Examples |
|---|---|
| HTML attributes | `src`, `srcset` (all candidates), `poster`, `data`, `data-src`, `data-srcset`, `data-lazy-src`, `data-original`, `data-bg`, `<source>`, `<track>`, `<video>`, `<audio>`, `<embed>`, `<object>` |
| `<link>` | stylesheet, icon / shortcut icon / apple-touch-icon / mask-icon, manifest, preload/prefetch (not `as=fetch/document`), modulepreload |
| Meta | `og:image(:url,:secure_url)`, `og:video`, `og:audio`, `twitter:image`, `msapplication-TileImage`, `itemprop=image` |
| CSS | `url()` and `@import` (string and `url()` forms), recursively through imported sheets, inline `style=""`, `<style>` blocks |
| Documents | same-site `<a href>` to files (`pdf, doc(x), xls(x), zip, csv, mp4, …`) |
| JavaScript | string literals that look like asset URLs (absolute, protocol-relative or root-relative with a known extension) in inline and external scripts (size < 2 MB) |
| Browser (JS/Full) | every image/font/stylesheet/media response the page actually loaded (scripts too in Full mode) |

## Behaviour

* **De-duplication** by normalised URL (in-flight downloads are shared) *and* by SHA-256 of the content: the second copy
  becomes `status: duplicate` and every reference is rewritten to the first file (saves space; tested including concurrent
  downloads — a race that let both copies through was found and fixed by testing).
* **Limits**: per-file cap enforced while streaming (`too_large` aborts the transfer), total quota checked before each write,
  external (CDN) assets optional, nesting depth ≤ 4 (CSS → CSS → font…).
* **Soft 404s**: a `.png/.css/.woff` URL answered with an HTML page is recorded as failed, not saved as an image.
* **Paths**: original structure is preserved (`/css/main.css → css/main.css`), other hosts go under `_ext/<host>/…`, a query
  string adds a short hash (`s__1a2b3c.css`), missing extensions are added from the content type, every segment is
  sanitised (`..`, control/reserved characters, Windows device names, length) and a case-insensitive registry resolves
  collisions.
* **Rewriting**: HTML attributes, `srcset`, inline CSS and downloaded CSS files are rewritten to **relative** paths. Lazy-load
  placeholders (`src="data:…"` + `data-src`) are promoted so images show without JavaScript. `integrity`/`crossorigin` are
  removed (rewritten CSS no longer matches the hash), `<base>` removed, charset normalised to UTF-8.
* **Assets that could not be archived** keep (or become) an **absolute live URL** rather than a path that would resolve
  against the disk root, and are listed in `assets-manifest.json` / "missing assets" in the report.
* **Rendered snapshots** (`js` mode) drop `<script>` tags (the DOM is already built); `full` mode keeps and downloads them.

## Assets behind a login

In a signed-in crawl the asset fetcher asks the profile's browser context for the cookies of each URL **per redirect
hop** and sends them only to the crawled site; a hop to another origin is requested without them. Assets that were
fetched without any session can be shared between the profile folders of a combined crawl (`public-assets.ts`); assets
fetched with a session never are.

## Not rewritten

JavaScript files are never modified: runtime-built URLs (`"/img/" + name + ".png"`) cannot be rewritten and may still point to
the live site (or to the wrong place for `file://`). See LIMITATIONS.md.
