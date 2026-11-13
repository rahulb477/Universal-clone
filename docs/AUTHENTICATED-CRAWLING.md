# Signed-in (authenticated) crawling

Archive the pages a site shows **to an account you are authorised to use**. Nothing here bypasses an access control:
the crawler signs in the way the account holder does, and whenever the site asks for a human (one-time code, CAPTCHA,
SSO, consent screen) the crawl waits and the human does that step personally.

Requires `CRAWLER_CREDENTIAL_ENCRYPTION_KEY` (32 random bytes; `openssl rand -base64 32`) on the web app **and** the
worker. Without it the feature is off and the UI says so. Security properties are in [SECURITY.md](SECURITY.md).

## Login with Browser (reusable saved logins)

The workflow most people want, and the one the start form offers first:

1. **Address.** Type the site you are allowed to archive.
2. **Login with Browser.** The worker opens the *real* site in its own isolated Chromium context. Nothing is filled in
   for you: you click, type, follow redirects, finish SSO, enter a one-time code or answer a CAPTCHA yourself, on as
   many pages as the sign-in needs.
3. **Use This Login.** The worker checks the session is really usable (see *What counts as signed in*), encrypts it and
   stores it against the profile. The window closes and the dashboard confirms “Login profile saved”.
4. **Start download.** The profile is attached to the crawl; the worker restores the session into a fresh context and
   crawls the signed-in pages. Progress, discovered pages, assets and errors appear as for any crawl.

Unlike the per-crawl profiles above, a saved login **outlives the crawl** and can be reused by later downloads.

### What a saved profile is

| Field | Meaning |
|---|---|
| Name | Free text, unique per owner. Rename at any time. |
| Site (`targetHost` + `targetOrigin`) | **The** scope. A saved login only ever matches this host (and its port). |
| Start URL | Where crawls begin; also where the browser opens when no sign-in page is known. |
| Login URL | Optional; where “Login with Browser” opens. Must be on the same site. |
| Authenticated-state selector | Optional. An element that is only visible when signed in; strongly recommended. |
| Match subdomains | Off by default. When on, `app.example.com` may use a login saved for `example.com` — never the other way round. |
| Status | `active`, `session-expired`, `session-rejected`, `needs-request-capture`, `login-failed`, each with a human label. |
| Last used / use count | When a crawl last restored it, and how many times. |

Ownership and site scope are enforced on the server for every operation: another user's profile answers an identical
`404` (existence is not leaked), and attaching a profile to a different site answers `400 … cannot be used for <host>`
without creating a job. The UI mirrors the same rule, so the checkbox for a foreign site is disabled and says why.

### What counts as signed in

“Use This Login” is never trusted on its own:

* With an **authenticated-state selector**, that element must be visible in the window.
* Without one, the page must have left the login URL, no password field may still be visible, and the browser must hold
  at least one cookie or storage entry for the site.
* Finally the captured state is scoped to the profile's host before it is encrypted: cookies for other domains are
  dropped, parent-domain cookies are kept, sub-domain cookies only when the profile allows them.

If any check fails the window stays open, says exactly what is missing, and you can try again. The profile itself is
never deleted by a failed attempt.

### Re-login, expiry and deletion

* A session has a lifetime (`CRAWLER_SAVED_SESSION_TTL_HOURS`, default 720 hours = 30 days). After that the profile
  shows **session expired** and offers a new sign-in.
* When a crawl finds the site rejecting the session (401/403 or a bounce to the login form) the profile is marked
  `session-rejected` and the UI offers “Sign in again”. Nothing silently falls back to anonymous crawling.
* **Forget login** removes the stored session but keeps the profile and its history; **Delete** removes both.
* **Sign in again** reopens the browser window on the same profile and replaces the stored session.

### Options

| Variable | Default | Meaning |
|---|---|---|
| `CRAWLER_LOGIN_BROWSER_MINUTES` | 15 | How long one window may stay open (max 60). An untouched window is closed after 90 s. |
| `CRAWLER_SAVED_SESSION_TTL_HOURS` | 720 | Lifetime of a saved session. |
| `CRAWLER_MAX_SAVED_PROFILES` | 25 | Profiles per user (max 200). |

All three are read by the web app and the worker; `CRAWLER_CREDENTIAL_ENCRYPTION_KEY` must be the same on both.

### When no worker is online

Profiles can be listed, renamed and deleted, but “Login with Browser” refuses with **“No crawl worker online”** and no
window is created. The panel says so up front, and an existing saved login is kept untouched.

### If a headless browser cannot hold the login

Some sites bind a session to the device that created it (a TLS fingerprint, a hardware check). For those, the panel's
**“Sign-in not saved?”** section accepts a signed-in request copied from your own browser (DevTools → Network →
*Copy as cURL*). Only its cookies and storage are kept, they are scoped to the site like any other capture, and the
`curl` command itself is never stored or executed.

## Login profiles for a single crawl

A crawl can carry up to five profiles (`CRAWLER_AUTH_MAX_PROFILES`). Each has a name, the login page URL and a sign-in
method:

| Method | What happens | Stored secret |
|---|---|---|
| **Automatic form login** | The worker fills in the username/password form and submits it. If the site then shows a verification step, the crawl waits for you (below). | Password, encrypted, until the crawl ends |
| **Manual sign-in** | You sign in yourself in the worker's isolated browser — for SSO, passkeys, CAPTCHAs, anything a form filler cannot do. | No password at all |

Fields: optional CSS selectors for the username, password and submit elements (auto-detected when omitted); an
**authenticated-state selector** — an element that is visible only when signed in, required for form logins and
recommended for manual ones; an optional **MFA selector** that identifies the site's verification page; and optional
**extra sign-in origins** for a manual sign-in that leaves the site (your SSO provider).

A login counts as successful only when the authenticated-state selector is visible. A redirect or a 200 is not enough.

## The manual sign-in / verification window

When a profile needs a person, the job shows “waiting for sign-in” and the page opens a panel with a live view of the
isolated browser (JPEG frames, about one per second). Click the picture to focus a field and type, or use the text box
for pasting; **Enter / Tab / Back / Reload** are buttons. The crawl continues by itself once the signed-in state is
detected, or press **I have finished signing in**. **Cancel sign-in** ends the attempt.

* Nothing is typed, clicked or solved for you in this window.
* With an MFA selector configured, an automatic login submits the password and then stops at the verification page
  without touching it. Without one, landing on an unexpected page fails the login (it does not guess).
* The window closes after `CRAWLER_INTERACTIVE_LOGIN_MINUTES` (default 10); the crawl then fails with nothing crawled.
* Waiting for you does not count against the crawl's time limit.
* The picture is the only thing that leaves the worker; the browser itself is never exposed to the network.
* If the provider opens a new tab or popup, the window follows the newest one (implemented; not covered by a test).

## Sessions: reuse, expiry, reauthentication

* After a successful sign-in the browser session (cookies and web storage) is saved encrypted for that profile. A crawl
  that is resumed — after a pause, a worker restart or a crash — restores it instead of signing in again.
* If a restored session turns out to be invalid it is discarded and the profile signs in again (form) or asks you (manual).
* During the crawl a 401/403 or a bounce to the login page triggers a probe of the signed-in state. Only if the probe
  fails is the session treated as expired: the crawl pauses with “Session expired — resume to reauthenticate”, the page
  it was on stays queued, and **Reauthenticate & Resume** continues from there.
* Saved sessions expire after `CRAWLER_SESSION_TTL_HOURS` (default 12) and are erased, together with the password,
  when the crawl completes, fails or is cancelled.

## What gets archived

* **Pages** reachable by links from the start URL inside the usual scope, rendered in the profile's browser context.
* **Protected assets** — images, stylesheets, fonts, SVG sprites, CSS backgrounds, lazy and responsive images that the
  server only serves to a signed-in user — are downloaded with the profile's session and rewritten to local paths.
  Cookies are attached per request hop and only for the crawled site; a redirect to another origin goes without them.
* **API discovery** (`apiDiscovery`, default `metadata`): the `fetch`/XHR calls the pages make are recorded in
  `_report/api-discovery.json`.
  * `metadata` — method, redacted URL, status, content type, size. No bodies.
  * `archive` — additionally stores JSON responses of GET requests, with secret-looking keys and values redacted
    (tokens, passwords, card and bank fields …; redaction is deliberately over-cautious). `apiFollowPagination` follows
    `next` links with GET.
  * `off` — nothing is recorded.
  * GraphQL: only endpoints you list in `graphqlEndpoints` are queried, only with read-only queries; mutations are
    never sent.
* **Never requested while signed in:** anything but GET/HEAD/OPTIONS, sign-out links, and links that look destructive
  (`delete`, `remove`, `unsubscribe`, `cancel-account`, `reset-password` …). These are listed in the report as skipped.

## Several profiles

| Mode | Result |
|---|---|
| **Separate archives** (default) | One independent crawl, ZIP and report per profile. |
| **Combined discovery** (needs ≥ 2 profiles) | URLs found by any profile are tried with every profile. One ZIP with a folder per profile (`profiles/<name>/…`), plus `_report/combined-report.json` and `_report/access-matrix.json` / `.csv`: for each URL, who discovered it and who can open it. |

Profiles stay isolated in both modes — separate browser contexts, cookies and private files. In combined mode only
assets that were fetched **without** any session are shared between the profile folders. A profile whose sign-in fails
contributes nothing and does not stop the others. After an interruption a combined crawl starts over (saved sessions
are still reused).

## Controls

* **Test Login** (single-server mode only; a web tier without a browser answers 501) runs the same verified sign-in and
  reports only the outcome.
* **Remove credentials / Clear session** erases a job's stored password and session immediately and ends the crawl if
  it is running. An interrupted crawl can then no longer be resumed.
* **Pause / Resume / Cancel** work as for public crawls; cancelling still packages what was downloaded.

## Not supported

* Sites that require a client certificate, a hardware-bound device check, or a browser extension.
* Scheduled re-crawls: a saved login can be reused by any later crawl, but nothing crawls on a timer.
* Sharing a saved login with another user — profiles are strictly per owner.
* Rewriting a stored session after a site rotates its token behind your back; the profile simply reports
  `session-rejected` and asks for a new sign-in.
* Archiving responses of non-GET API calls, WebSocket traffic or server-sent streams.
* Passkey/WebAuthn prompts cannot be answered through a picture of a remote browser; use another sign-in method.
* The remote window forwards clicks, typing, scrolling and a few navigation keys — no drag-and-drop, file upload,
  clipboard access or multi-touch, which rules out some CAPTCHA styles.

## How it was tested

Against a test-owned site (`tests/fixtures/auth-site.ts`) with a real cookie session, a one-time-code step, role-based
pages, protected assets, JSON and GraphQL APIs, and destructive endpoints that count every hit — in a real Chromium, and
end to end through the HTTP API, the worker process and the web UI. The “Login with Browser” flow is covered by
`tests/integration/saved-login-profiles.test.ts` (real PostgreSQL, real Chromium, real worker) and
`tests/e2e/saved-login-ui.test.ts` (the production build driven in a browser, including a 390 px phone layout). It has
**not** been run against third-party login
providers (Google, Microsoft, Okta, Auth0 …) or real CAPTCHA services. Results: [TESTING-REPORT.md](TESTING-REPORT.md).
