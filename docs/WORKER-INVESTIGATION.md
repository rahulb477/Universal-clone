# Production worker investigation and deployment report

## Evidence and limits

The report of `/api/health` returning `{"ok":true,"worker":"offline"}` means the web process could execute its database queries but saw no recent worker row in **its** database. It does not prove the worker reached its queue loop or that Hostless and Vercel share a database. Hostless's “Running” state and a READY Vercel deployment are not evidence of either. Production logs, configuration, database access, the live health response and a live job were not available to this investigation. **The exact production root cause remains unverified.** Do not infer that the previous Chromium error is still occurring.

One independently demonstrated code defect can cause persistent offline status: the old heartbeat used an UPDATE without checking its row count. Another worker's recovery deletes rows older than ten minutes; after an extended outage or deletion, the surviving process could UPDATE zero rows forever. This change atomically upserts its row on every heartbeat. A concurrent heartbeat is suppressed and shutdown waits for an in-flight heartbeat before deleting the row. This fixes that failure mode, not necessarily the observed production incident.

## Lifecycle and failure points

* `drizzle/0001_users_ownership_queue.sql` creates `workers` with `started_at` and `heartbeat_at` as `timestamptz`. PostgreSQL stores absolute instants; session timezone affects display, not comparisons. No migration or data reset is introduced by this change.
* The standalone worker checks its browser (including a real page), optional migrations, database connection, writable scratch space and archive store before recovery and registration. A process that fails any of these checks has not registered. Registration is a committed single-statement upsert, not part of a long transaction. The new redacted log `worker_registered` confirms it succeeded; `started` confirms the queue timers were installed. Check both, not just the supervisor status.
* A heartbeat runs every 5 seconds and now uses database `now()`; it also updates running jobs and performs stale-job recovery. Web status is `SELECT id FROM workers WHERE heartbeat_at > now() - interval '30 seconds' LIMIT 1`; there are no status or worker-ID filters. Previously web and worker used their separate system clocks, so clock skew could change the answer. Stale worker rows older than 10 minutes are deleted during recovery. Running/paused job recovery uses `WORKER_STALE_SECONDS` (default 45, minimum 15), a separate timeout.
* Queue claims use an atomic `UPDATE ... WHERE id = (SELECT ... WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`. The worker writes progress and completion/events to PostgreSQL and archives to the configured store. Web and worker must share the same actual Neon branch and database, and matching archive configuration and encryption key.
* On heartbeat failure, structured logs show a redacted SQLSTATE/network code and pool total/idle/waiting counts. Repeated failures or a rising waiting count call for checking network/TLS, grants, schema (`42P01` often means missing table), Neon connection limits and `DATABASE_POOL_MAX` (default 10 per process). Do not paste raw environment variables or connection errors into tickets. The worker retries on the next interval.

## Safe database identity comparison

After deploying this change to **both** tiers, request the web health route and find `database_identity` in Vercel server logs; find the worker's corresponding event in Hostless logs. Compare the SHA-256 fingerprint of the configured endpoint hostname and decoded database name, ignoring credentials and URL query parameters. Logs contain neither hostname nor database name nor credentials. Restrict access to these logs: hashing low-entropy names is not a substitute for access control. No fingerprint is exposed through the public health endpoint.

A mismatch is actionable but **not conclusive**: Neon pooled and direct endpoint hostnames, DNS aliases or different proxies may address the same database. Verify the actual Neon project, branch and database in platform configuration without exposing URLs. If endpoints should match, copy the existing correct connection setting to the worker and redeploy; never point the web at a new database to make the symptom disappear. Matching hashes are also not definitive proof when proxies or DNS route differently. When both tiers intentionally use the same endpoint hostname, optionally set Hostless `DATABASE_EXPECTED_FINGERPRINT` to the web fingerprint: a mismatch fails startup with a clear error. Do not set this guard for intentionally different endpoint aliases. A comparison can only be made after both logs exist; prior to deployment there is no automatic knowledge of the other tier's configuration.

## Hostless manual environment (production)

Set values in Hostless's secret manager; never print them. Copy existing values from the Vercel **production** environment where stated; do not create, rotate, or guess them. A change requires a worker redeploy/restart. The Hostless YAML does not populate these settings.

| Variable | Worker setting / source |
|---|---|
| `DATABASE_URL` | Required. Copy the Vercel production URL, or verify a deliberate separate endpoint points to the exact same Neon project, branch and database. |
| `DATABASE_SSL` | Copy Vercel's setting if set; `require` verifies TLS certificates, `no-verify` disables verification and is not recommended. If unset, driver URL options may still enable TLS. Use Neon's supplied TLS connection settings; do not assume unset means TLS is active. |
| `CRAWLER_CREDENTIAL_ENCRYPTION_KEY` | Copy the existing Vercel production value exactly; do not rotate. Required for existing saved login/credential compatibility. |
| `ARCHIVE_STORAGE` | `s3` on both tiers. |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Copy the existing Vercel production values for the same private Backblaze B2 bucket; do not generate new credentials. |
| `S3_ENDPOINT` | Copy the existing B2 S3-compatible endpoint from Vercel; do not guess it. |
| `S3_FORCE_PATH_STYLE` | Copy Vercel's setting if configured. If unset, the documented default is `1` when `S3_ENDPOINT` is set; ensure this matches the existing bucket configuration. |
| `CRAWL_DATA_DIR` | `/data`, on a writable persistent volume. Required to resume after restart; ensure the worker user can write it. |
| `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST` | `8080` and `0.0.0.0`; supervisor path `/healthz`. This is liveness/database reachability, not proof of visible heartbeat or queue processing. |
| `CRAWLER_WORKER_MODE` | Set `external` on Vercel (default when `VERCEL` is set). It is read by the web tier; setting it on the standalone worker has no effect. |
| `DATABASE_EXPECTED_FINGERPRINT` | Optional; only after comparing logs as above. |

Other knobs in `.env.example` are optional; preserve any intentional production limits and Chromium overrides. `WORKER_MIGRATE=1` is optional, not normally required on an existing migrated database. Inspect `schema_migrations` before applying missing migrations under normal change control. The migration tool constructs a separate pool from the URL, so ensure the URL itself supplies the required TLS options; it does not use `DATABASE_SSL`. Never reset the database or delete accounts. Avoid changing authentication, B2 credentials or encryption settings.

## Chromium and rollout verification

PR #6's browser selection remains unchanged: no automatic fallback, no `/tmp/fonts` chown. `npm run chromium:install` checks executable permissions and shared libraries and performs a real Playwright page launch. Worker startup repeats the page launch. Verify these on the actual non-root Hostless runtime with a writable **and executable** `TMPDIR`, sufficient space and required Linux libraries; this repository cannot certify the host runtime. If it fails, use the redacted logs and PR #6 runtime guidance, not a browser fallback.

1. Merge and deploy the new web and worker code; verify their deployed commit identifiers. Preserve the existing environment and data. Confirm the browser probe, `database_connected`, `worker_registered`, `started`, and recurring `heartbeat_ok` in Hostless. Investigate any earlier error; a supervisor “Running” state alone is insufficient.
2. Compare fingerprints as above. Verify `workers` exists and a row has a recent `heartbeat_at` using database `now()`. If not, inspect redacted error codes, pool counts, permissions, migrations and connection health. Do not copy secrets to logs.
3. Request production `GET /api/health` with cache bypass; acceptance requires exactly `{"ok":true,"worker":"online"}`. A 503 means web database/query failure; offline means no fresh visible row, not necessarily a browser problem.
4. Using a permitted test site and an existing account, queue a small test crawl. Confirm it moves from queued to running, is claimed by the expected worker, persists progress/completion and produces an accessible B2 archive. Verify the corresponding job events and worker logs without exposing crawl credentials.
5. Record the commit, time, health response, job ID and outcome. Only then declare production acceptance. If either health or claim fails, leave the incident open and use the diagnostics above.

## Local validation in this branch

On the sandbox's non-root Linux runtime (not Hostless), `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run chromium:install`, and `npm test` passed. The full suite reported 306 passed and 2 intentionally skipped live-network tests. The focused split-worker suite passed 14 tests; a further focused test verified the same recovered worker claimed a new crawl and persisted its progress, completion and done event. One concurrent focused run initially failed its Chromium extraction with `Premature close`; a retry using the already validated local Chromium executable passed. This does not establish Hostless runtime compatibility or production acceptance.
