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
* **Browser (Chromium)**: every request of every page goes through a route handler that applies the same hostname/IP rules
  (verdict cached per host), aborts non-`GET/HEAD/OPTIONS` requests (no form posts, no mutating XHR), blocks non-http(s)
  schemes, disables service workers and downloads. *Residual risk*: the browser resolves DNS itself, so a rebinding attack
  against the browser is mitigated only by the per-host pre-check (see LIMITATIONS.md).
* **Operator switch**: `CRAWLER_ALLOW_PRIVATE_NETWORKS=1` disables these rules for intranet/testing use. It is read from
  the server environment only; there is no API parameter for it.

## Scope & politeness

Domain boundary enforced for pages (and redirects); `robots.txt` honoured by default (allow/disallow with longest match,
wildcards, `$`, `Crawl-delay`); per-host request spacing; bounded concurrency; identifies itself as `SiteArchiverBot/2.0`.
The UI requires an explicit statement that the user owns the site or has permission. Authentication, paywalls, CAPTCHAs and
access controls are never bypassed (no cookies, no credentials, 401/403 are reported as failures).

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
