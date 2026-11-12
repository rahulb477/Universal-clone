# Authenticated crawling (implementation scope and operations)

Authenticated form login is an opt-in extension of the existing crawler. It is not enabled unless both server secrets below are configured. Do not deploy it on a public host without TLS and a trusted operator-controlled front end.

## Required environment secrets

- `CRAWLER_AUTH_API_TOKEN`: a random, high-entropy operator bearer token, at least 32 characters. Provision it outside source control and provide it only to an authorized operator. The UI keeps it in component memory and sends it only in the `Authorization` header to authentication endpoints.
- `CRAWLER_CREDENTIAL_ENCRYPTION_KEY`: exactly 32 random bytes encoded as 64 hex characters or base64. It encrypts each profile envelope with AES-256-GCM. Losing/changing this key prevents interrupted authenticated jobs from resuming.
- Optional `CRAWLER_AUTH_MAX_PROFILES`: server profile cap, 1–5 (default 5). Each profile starts a separate job/archive; the manager's concurrent-job cap also applies.

Example key creation (keep the output in your deployment secret manager, not in the repository):

```sh
openssl rand -hex 32
openssl rand -base64 32
```

The UI accepts standard email/username + password forms, optional CSS selectors for the fields/button, and a required CSS selector that must be visible after a successful login. The selector provides an explicit verification condition: a successful form submission or a redirect by itself is not considered authentication success. Login POSTs are allowed only during the login phase, only to the configured login page's exact origin, only for a bounded number of top-level form submissions; all other browser mutations remain blocked. Crawled browser requests remain GET-only.

Profile credentials are AES-256-GCM encrypted in a mode-0600 `auth.enc` file outside the archive. Crawl options and API responses contain no password. The profile runs in its own Chromium context and its own job directory/archive. Cookie/session state is held in memory only; on an interrupted-job resume the encrypted credentials are used to sign in again rather than restoring plaintext cookies. Credentials are removed from memory at terminal completion/cancellation/failure and encrypted credential files are removed for terminal outcomes. A paused session-expiration job retains its encrypted profile until resumed or explicitly cleared.

The “Test Login” endpoint uses the same verified login flow but closes the context immediately and returns only a status. “Remove Login” removes that profile from the current UI; for an already-started job use “Remove Credentials / Clear Session” to cancel its active browser context and erase its encrypted credential file. A session expiration (401/403 or redirect to the configured login page) pauses that profile; “Reauthenticate & Resume” repeats the verified form login and reuses saved crawl state.

## Explicit unsupported scope

This increment does **not** implement remote/visible manual browser login, human-completed MFA/CAPTCHA, a combined-discovery archive mode, authenticated asset downloads via browser cookies, or authenticated API/XHR crawling. Automated login will fail closed if a human challenge is required; no CAPTCHA/MFA bypass is attempted. The separate archive mode is the only supported multi-profile mode, preserving isolation rather than merging account data. The regular crawler's non-authentication APIs remain unauthenticated as in the existing application; put the whole service behind a trusted network/access-control proxy. Auth-specific endpoints and authenticated crawl creation require the operator token.

## Controlled integration fixture

`tests/fixtures/auth-site.ts` is a local, test-owned cookie-protected website with a real POST login and protected dashboard, nested orders and settings routes. `tests/integration/authenticated-crawl.test.ts` exercises separate profile archives, session isolation, authenticated nested GET discovery, invalid credentials, and password redaction when Chromium is available. `tests/unit/auth.test.ts` covers authenticated encryption, tamper rejection, profile validation, API token checks, and password omission.
