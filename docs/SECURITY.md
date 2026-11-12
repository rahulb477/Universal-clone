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
  except up to three form-document POSTs to the exact configured login origin during the explicit login phase. *Residual risk*:
  the browser resolves DNS itself, so rebinding is mitigated only by the per-host pre-check (see LIMITATIONS.md).
* **Operator switch**: `CRAWLER_ALLOW_PRIVATE_NETWORKS=1` disables these rules for intranet/testing use. It is read from
  the server environment only; there is no API parameter for it.

## Scope & politeness

Domain boundary enforced for pages (and redirects); `robots.txt` honoured by default (allow/disallow with longest match,
wildcards, `$`, `Crawl-delay`); per-host request spacing; bounded concurrency; identifies itself as `SiteArchiverBot/2.0`.
The UI requires an explicit statement that the user owns the site or has permission. Paywalls and access controls are never
bypassed. The opt-in form-authentication flow described in [AUTHENTICATED-CRAWLING.md](AUTHENTICATED-CRAWLING.md) requires
explicit operator authorization and verified login state; CAPTCHA/MFA are not bypassed.

## Authenticated profile controls

* Only authenticated crawl creation, login testing, and credential/session clearing are protected by the operator bearer token
  `CRAWLER_AUTH_API_TOKEN` (minimum 32 characters). Provision the token outside source control. Existing non-auth API routes
  do not have application-level authorization; deploy behind a trusted access-control proxy.
* Credentials are serialized only into an AES-256-GCM authenticated envelope using the deployment-only
  `CRAWLER_CREDENTIAL_ENCRYPTION_KEY`. The encrypted file has restrictive permissions, is outside the ZIP, and is not copied
  into crawl options or API responses. Session cookies are in-memory only. Credentials are cleared from crawler memory at
  terminal outcomes; encrypted profiles are retained only for an interrupted/paused job that may be resumed.
* Login browser mutation is narrowly enabled during the configured login phase, only for bounded form POSTs to the exact login
  origin. Every other browser request remains GET/HEAD/OPTIONS. Browser GETs retain SSRF checks and page scope checks.
* Each profile runs as a distinct crawler/job/archive/context; no profile shares cookies or page state with another. This is
  separate-archive mode only; there is no combined archive mode. Authenticated assets fetched by the HTTP asset manager do not
  inherit browser cookies.
* Login selectors must include a visible authenticated-state element. A POST/redirect alone is never treated as success. 401,
  403, or a redirect to the configured login URL pauses that profile; resume replays the configured login and verifies state.
* Manual browser login/MFA, combined discovery, and authenticated XHR/API requests are not implemented. The feature fails closed
  for manual-mode requests and never attempts to bypass human challenges.

## Resource limits

Per-file and total byte caps (enforced while streaming), page and depth caps, wall-clock limit, per-request timeouts
(socket idle + total), global storage quota, max concurrent jobs, per-IP start rate limit, hard ceilings that clamp any
user-provided option (`sanitizeOptions`), retention cleanup (default 24 h).

## Filesystem safety

* Remote names never become paths directly: segments are sanitised and every write goes through `safeJoin` (resolved path must
  stay inside the job directory).
* ZIP entries are validated (`isSafeArchiveName`: no absolute paths, drive letters, backslashes, NULs, `..`), symlinks are
  skipped; tested with traversal-style URLs.
* Job IDs are 16 hex characters, validated on every route; report files are a fixed whitelist; report HTML is served with
  `Content-Security-Policy: default-src 'none'; …; sandbox`, `nosniff`, and all crawled text in it is HTML-escaped.

## Not covered

No user authentication / authorisation on the API (deploy behind a proxy if exposed). Rate limiting is in-memory per process
and trusts `X-Forwarded-For`. Chromium runs with `--no-sandbox` unless `CRAWLER_CHROMIUM_SANDBOX=1` (typical for containers) —
run the service in an isolated container/VM with restricted egress for defence in depth.
