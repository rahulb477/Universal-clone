# Security

The application fetches user-supplied URLs, so every layer assumes hostile input.

## SSRF protection (`security.ts`, `http.ts`, `renderer.ts`)

* **Scheme** must be `http`/`https`; URLs with embedded credentials are rejected.
* **Hostnames** blocked: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.localdomain`, `*.lan`, `*.home.arpa`,
  `metadata`, `metadata.google.internal`, `instance-data`, `kubernetes.default.svc`.
* **IP ranges** blocked (IPv4): `0/8, 10/8, 100.64/10, 127/8, 169.254/16 (cloud metadata), 172.16/12, 192.0.0/24,
  192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4`. IPv6: `::`, `::1`, `fc00::/7`, `fe80::/10`,
  `fec0::/10`, `ff00::/8`, `2001:db8::/32`, and **embedded IPv4** in IPv4-mapped (`::ffff:a.b.c.d`), compatible, NAT64 and
  6to4 addresses. Decimal/hex/octal/short IPv4 forms (`2130706433`, `0x7f.1`, `127.1`) are normalised by the URL parser
  and then blocked (tested).
* **DNS rebinding**: the address check runs inside the connection's own `lookup` callback, i.e. on the exact address that
  is connected to — there is no "resolve, check, resolve again" gap.
* **Every redirect hop** is re-validated (syntax, IP rules, scope), max 8 hops, loops detected.
* **Browser (Chromium)**: every request goes through a route handler that applies the same hostname/IP rules (verdict cached
  per host), blocks non-http(s) schemes, disables service workers and downloads. All non-GET/HEAD/OPTIONS requests are aborted
  except form-document POSTs during an explicit sign-in phase, and then only to the configured login origin (plus the
  extra sign-in origins the user listed for a manual sign-in, e.g. an SSO provider). *Residual risk*:
  the browser resolves DNS itself, so rebinding is mitigated only by the per-host pre-check (see LIMITATIONS.md).
* **Operator switch**: `CRAWLER_ALLOW_PRIVATE_NETWORKS=1` disables these rules for intranet/testing use. It is read from
  the environment of the process that runs the crawl (the worker); there is no API parameter for it. All workers on one
  database must use the same value — a job is checked by whichever worker claims it.

## Scope & politeness

Domain boundary enforced for pages (and redirects); `robots.txt` honoured by default (allow/disallow with longest match,
wildcards, `$`, `Crawl-delay`); per-host request spacing; bounded concurrency. The crawler identifies itself as
`UniversalCloneBot/3.1` and obeys robots groups addressed to `UniversalCloneBot` or to the pre-3.1 name `SiteArchiverBot`.
Starting a crawl requires an explicit statement that the user owns the site or has permission (enforced by the API, not
only the UI). Paywalls, CAPTCHAs, MFA and access controls are never bypassed: when a site asks for a human, a human
answers (see [AUTHENTICATED-CRAWLING.md](AUTHENTICATED-CRAWLING.md)).

## Accounts, sessions and ownership (`src/lib/server/users.ts`, `jobs.ts`)

* **Every API route except `/api/health` and the sign-in/registration endpoints requires a signed-in user.** Anonymous
  requests get `401`; `/api/auth/me` answers anonymous visitors with `{user: null}` and nothing else.
* **Passwords**: 10–200 characters, scrypt (N=2¹⁵, r=8, p=1) with a per-user random salt, constant-time comparison. A
  sign-in attempt for an unknown address costs the same hash computation as a real one.
* **Sessions**: a 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` and `__Host-`-prefixed in
  production). Only its SHA-256 is stored, so a database leak does not yield usable sessions. Signing out deletes the
  row. Lifetime `AUTH_SESSION_TTL_HOURS` (default 7 days).
* **CSRF**: every non-GET request must carry `x-csrf-token` (an HMAC of the session token, handed out by
  `/api/auth/me`) **and** come from the same origin (`Sec-Fetch-Site` / `Origin`, or the `APP_ORIGIN` allow-list).
* **Registration** is closed by default (`npm run user:create`). `invite` mode compares the code in constant time.
* **First administrator (`/setup-admin`)**: gated by the server-only `ADMIN_SETUP_KEY` (≥ 32 characters, plus an
  entropy/placeholder check; timing-safe SHA-256 + `timingSafeEqual` comparison). Same-origin and
  `application/json` are required, attempts are rate-limited in PostgreSQL (5 / 15 min per client, 100 / 15 min
  overall), and the "no administrator yet" check plus the insert happen in one transaction behind
  `pg_advisory_xact_lock`, so the endpoint cannot be raced into a second administrator. It answers `409` once a
  marker row exists and `503` without a key. The key is never sent to a client, logged, or stored. See
  [ADMIN-SETUP.md](ADMIN-SETUP.md).
* **Rate limits** are stored in PostgreSQL, so they hold across instances: sign-in 10 / 15 min per address and
  100 / 15 min per client IP, registration 10 / h per IP, crawl starts `CRAWLER_STARTS_PER_MINUTE` per user, login tests
  10 / 10 min, sign-in input events 1200 / min. The client IP comes from `X-Forwarded-For` only as far as
  `TRUSTED_PROXY_HOPS` says it can be trusted (default: not at all).
* **Ownership**: every job, profile, sign-in session, event and command row carries the owner, and every query filters
  by it. Another user's job id answers `404` on every route — status, events, download, reports, control, credentials,
  sign-in frames and input (tested route by route). Rows left over from version 3.0 have no owner and are reachable by nobody.
* **Quotas per user**: concurrent crawls, starts per minute, stored bytes; finished crawls are deleted after
  `CRAWL_RETENTION_HOURS`.

## Separation of web tier and worker

The web tier only reads and writes PostgreSQL and the archive store. It never launches a browser, never fetches a
user-supplied URL and never decrypts a site password or session — it encrypts what the user submits and hands it to the
queue. Only the worker (`src/worker/worker.ts`) decrypts credentials, and only while it runs that job. In `external`
mode `POST /api/auth/test` answers `501` rather than starting a browser in the web tier.

## Secrets at rest

* Site passwords, saved browser sessions (cookies + storage), typed sign-in input in transit through the queue, and the
  screenshots of the manual sign-in browser are stored only as AES-256-GCM envelopes (`v2.<iv>.<tag>.<ciphertext>`)
  under `CRAWLER_CREDENTIAL_ENCRYPTION_KEY`. Each envelope is bound to its purpose and row (`profile:<id>`,
  `session:<id>`, `login-frame:<id>`, `cmd:<jobId>`) as authenticated data, so a ciphertext copied onto another row
  does not decrypt.
* They are **erased when the crawl reaches a final state** (`completed`, `failed`, `cancelled`): `secret` and
  `session_state` become `NULL`, `cleared_at` is set. They are kept — encrypted — only while a crawl is queued, running,
  paused or interrupted, because resuming needs them. The owner can erase them at any time (“Remove credentials”),
  which also ends the crawl if it is running. Sign-in screenshots are deleted when the sign-in ends.
* Passwords never appear in API responses, logs, events, reports or the ZIP (asserted in tests against process output,
  database rows, the archive bytes and the rendered page). The UI drops the password from its own state as soon as the
  crawl is created.
* Losing or changing the key makes unfinished signed-in crawls unresumable; it does not affect finished archives.

## Signed-in crawling controls

* One isolated Chromium context per profile; profiles never share cookies, storage or cached private responses.
* The session cookie is attached to an asset or API request **per hop and only for the site being crawled** — a redirect
  to another origin is followed without it.
* While crawling, the browser may only issue GET/HEAD/OPTIONS. Sign-out links and destructive-looking GET links
  (`/logout`, `/delete`, `/unsubscribe` …) are never followed. API discovery replays GET requests and read-only GraphQL
  queries only; mutations are never sent.
* A sign-in counts as successful only when the user's “authenticated-state” selector is visible — not on a redirect or a
  200. A later 401/403 or bounce to the login page is treated as an expired session only if a fresh probe confirms it.
* **Manual sign-in** runs in the worker's isolated browser; the owner sees JPEG frames and sends clicks/keys through the
  API. Input events are validated (type, coordinates, key names, text length), frames are readable by the owner only,
  form submissions are limited to the login origin plus explicitly listed sign-in origins, and the window closes after
  `CRAWLER_INTERACTIVE_LOGIN_MINUTES`. Nothing is filled in or solved automatically during a manual sign-in.

## Archive storage

* `local`: files live outside the web root under a key derived from the validated job id; the download route streams
  them after the ownership check.
* `s3`: the bucket must be private. A download is a `302` to a pre-signed GET valid for `DOWNLOAD_URL_TTL_SECONDS`
  (default 60 s, max 1 h), issued only after the ownership check and never cached (`no-store`). Anyone holding that URL
  can use it until it expires — that is inherent to pre-signed links. Reports are proxied through the app instead.
* Object keys are built from validated ids and a fixed file whitelist; keys containing `..` or `//` are rejected.
* Each archive's SHA-256 is recorded at packaging time and returned with the job.

## Resource limits

Per-file and total byte caps (enforced while streaming), page and depth caps, wall-clock limit, per-request timeouts
(socket idle + total), per-user quotas (above), `CRAWLER_MAX_CONCURRENT_JOBS` per worker, hard ceilings that clamp any
user-provided option (`sanitizeOptions`), retention cleanup (default 24 h).

## Filesystem safety

* Remote names never become paths directly: segments are sanitised and every write goes through `safeJoin` (resolved path must
  stay inside the job directory).
* ZIP entries are validated (`isSafeArchiveName`: no absolute paths, drive letters, backslashes, NULs, `..`), symlinks are
  skipped; tested with traversal-style URLs.
* Job IDs are 16 hex characters, validated on every route; report files are a fixed whitelist; report HTML is served with
  `Content-Security-Policy: default-src 'none'; …; sandbox`, `nosniff`, and all crawled text in it is HTML-escaped.

## Response headers (`src/proxy.ts`)

Pages: `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` and
`X-Frame-Options: DENY`. Everything: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, a restrictive
`Permissions-Policy`, and HSTS in production. API routes set their own CSP where they serve crawled content.
`APP_EMBED_ORIGINS` relaxes framing for the listed origins and switches the cookie to `SameSite=None; Secure;
Partitioned`; leave it unset in production.

## Not covered / residual risk

* The page CSP does not restrict script sources (Next.js inlines bootstrap scripts; no nonce pipeline is set up). The app
  renders crawled text through React only, and crawled HTML is never served from the app's origin outside the sandboxed
  report route.
* No email verification, password reset, second factor or account lockout notification for app accounts. An operator
  resets a password by deleting the user row and creating the account again; that cascades to the user's job rows, so
  delete the user's downloads in the UI first or their archive files stay in the store until removed by hand.
* An `admin` role exists and gates `GET /api/admin/overview` (account list and counts). There is no admin UI
  beyond that read-only endpoint, and no password reset flow — losing the administrator password requires the
  operator procedure in [ADMIN-SETUP.md](ADMIN-SETUP.md) §6.
* Chromium runs with `--no-sandbox` unless `CRAWLER_CHROMIUM_SANDBOX=1`. Run workers in an isolated container/VM with
  restricted egress (in particular: no route to cloud metadata or internal services) for defence in depth.
* In Chromium, DNS is resolved by the browser, so DNS rebinding is mitigated by the per-host pre-check only.
* Whoever holds `DATABASE_URL` **and** `CRAWLER_CREDENTIAL_ENCRYPTION_KEY` can read the credentials of unfinished
  crawls. Keep the key out of the database host.
* No independent security review or penetration test has been performed.
