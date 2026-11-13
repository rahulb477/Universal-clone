# Deployment

Universal Clone has three parts that must agree with each other:

| Part | What it is | What it needs |
|---|---|---|
| **Web app** | Next.js (`npm run build && npm start`, or Vercel) — sign-in, API, live updates, download links | PostgreSQL, the archive store |
| **Worker** | `npm run worker` — a long-running Node process that launches Chromium and runs the crawls | PostgreSQL, the archive store, Chromium, scratch disk |
| **State** | PostgreSQL (accounts, queue, events) and an archive store (local directory or an S3-compatible bucket) | – |

The web app never launches a browser and never decrypts a site password. It writes jobs into PostgreSQL; a worker
claims them (`SELECT … FOR UPDATE SKIP LOCKED`), reports progress into PostgreSQL, and uploads the result to the store.

Every variable is listed with its default in [`.env.example`](../.env.example).

## Choose a layout

| Layout | When | `CRAWLER_WORKER_MODE` | Storage |
|---|---|---|---|
| **A. Single server** | One VM/container you control | `inline` (default off Vercel): the web process also runs the worker loop | `local` is fine |
| **B. Web + worker(s)** | Vercel or any serverless/auto-scaled web tier; several workers | `external` (default on Vercel) | **`s3`** unless web and workers mount the same disk |

A serverless function cannot run a multi-minute Chromium crawl, so on Vercel layout B is the only one that works:
without a worker, crawls stay `queued` and the UI shows “No crawl worker online”.

## Common steps

```bash
npm install
openssl rand -base64 32                       # → CRAWLER_CREDENTIAL_ENCRYPTION_KEY (same value for web and worker)
npm run db:migrate                            # creates/updates the schema; safe to run on every deploy
USER_PASSWORD='…' npm run user:create -- you@example.com admin   # or omit USER_PASSWORD and type it on stdin
```

* `npm run db:migrate` applies the SQL files in `drizzle/` in order, each in its own transaction, and records them in
  `schema_migrations`. It takes a PostgreSQL advisory lock, so parallel deploys do not collide. A database created by
  version 3.0 (`drizzle-kit push`) is upgraded in place; its existing rows have no owner and are therefore invisible to
  every account (delete them or assign `owner_id` by hand).
* Registration is **closed** by default: accounts exist only when an operator creates them. `AUTH_REGISTRATION=invite`
  plus `AUTH_INVITE_CODE` (≥ 16 characters) or `AUTH_REGISTRATION=open` enable self-service sign-up.
* The repository does not commit a `package-lock.json` (it is git-ignored), so installs resolve versions within the
  ranges in `package.json`. For reproducible production builds generate a lockfile once, keep it with your deployment,
  and use `npm ci`.
* The command-line tools (`worker`, `db:migrate`, `user:create`) read `.env` from the working directory when it exists;
  real environment variables take precedence.

## Layout A — single server

```bash
npm run build
npx playwright-core install --with-deps chromium     # or set CHROMIUM_PATH to an installed Chromium/Chrome
DATABASE_URL=… CRAWLER_CREDENTIAL_ENCRYPTION_KEY=… CRAWL_DATA_DIR=/var/lib/universal-clone npm start
```

Put it behind a TLS-terminating reverse proxy and set `TRUSTED_PROXY_HOPS` to the number of proxies in front of it (it
decides which `X-Forwarded-For` entry rate limiting trusts). Run a single instance: two inline servers on one database
both consume the queue, which is fine only if they are configured identically.

## Layout B — Vercel (web) + worker

**Web (Vercel project settings → Environment Variables):** `DATABASE_URL` (a pooled connection string is fine),
`DATABASE_SSL=require` if the provider needs it, `CRAWLER_CREDENTIAL_ENCRYPTION_KEY`, the `S3_*` variables,
`AUTH_REGISTRATION` as desired, and `TRUSTED_PROXY_HOPS=1` (without it every visitor shares one per-IP rate-limit
bucket). `CRAWLER_WORKER_MODE` defaults to `external` there. Function limits to keep in mind: the live-update stream
closes after `SSE_MAX_SECONDS` (default 280) and the browser reconnects where it left off, so set the function's
maximum duration to at least that or lower the variable to fit your plan.

**Worker (any host that keeps a process running: a VM, Fly.io, Railway, Render, ECS, a Kubernetes Deployment):**

```bash
npm install
npx playwright-core install --with-deps chromium
DATABASE_URL=… CRAWLER_CREDENTIAL_ENCRYPTION_KEY=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
WORKER_HEALTH_PORT=8080 CRAWL_DATA_DIR=/var/lib/universal-clone npm run worker
```

At start the worker verifies each dependency and **exits with a clear message instead of running half-configured**:
no `DATABASE_URL`, Chromium missing or not starting, or the archive store rejecting a write/read/delete round-trip
(for example `object storage upload failed: HTTP 403` with a wrong secret). On success it logs the Chromium version and
`[worker <id>] started (max 5 concurrent jobs, storage: s3)`.

Operational rules:

* **Run the worker as one process.** `npm run worker` is `node --import ./scripts/load-env.mjs --import tsx
  src/worker/main.ts`. Do not start it through a wrapper that forks a child (the `tsx` CLI does): the supervisor's
  SIGTERM then reaches only the wrapper, the real worker keeps crawling, and nothing is saved. In a container use the
  exec form (`CMD ["node", "--import", "./scripts/load-env.mjs", "--import", "tsx", "src/worker/main.ts"]`).
* **Shutdown.** On SIGTERM/SIGINT the worker saves every running crawl, marks it `interrupted` and exits 0. Give it a
  grace period of at least 30 s. The owner resumes an interrupted crawl from the UI; finished pages are not fetched again.
* **Crashes.** A worker that dies without a signal leaves its crawls `running`. Any other worker marks them
  `interrupted` once the heartbeat is older than `WORKER_STALE_SECONDS` (default 45). Crawls are never restarted
  automatically — resuming is always the owner's decision.
* **Health.** `GET /healthz` on `WORKER_HEALTH_PORT` returns 200 while the database is reachable. The web app's
  `GET /api/health` returns `{ok, worker: "online" | "offline"}` (a worker heartbeat within 30 s). It checks the database
  and the heartbeat only; it does not probe the archive store, so a broken bucket shows up as failed crawls, not here.
* **Scaling.** Start more workers against the same database; each job is claimed by exactly one. A worker runs up to
  `CRAWLER_MAX_CONCURRENT_JOBS` crawls; budget roughly one Chromium (several hundred MB of RAM) per running crawl.
* **One network policy per database.** `CRAWLER_ALLOW_PRIVATE_NETWORKS` is evaluated by the worker that runs the job.
  Workers with different values on one queue make the outcome depend on which worker happens to claim the job.
* **Retention.** Each worker deletes crawls that have ended (completed, cancelled, failed or interrupted) once they
  are older than `CRAWL_RETENTION_HOURS` (default 24, counted from creation): database rows, archive, reports. It also
  removes scratch directories whose job no longer exists. Set a larger value if downloads must stay available longer.
* **Disk.** `CRAWL_DATA_DIR` is scratch space; a crawl's directory is deleted after its ZIP is uploaded. It must survive
  a restart of the same worker for “resume” to continue where it stopped — on a host with ephemeral disks a resumed
  crawl starts again from the first page (signed-in sessions are still restored from the database).

### Container example (not built or run during development — no Docker in that environment)

```dockerfile
FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
ENV NODE_ENV=production CRAWL_DATA_DIR=/data
USER pwuser
CMD ["node", "--import", "./scripts/load-env.mjs", "--import", "tsx", "src/worker/main.ts"]
```

Treat this as a starting point: the image tag must match the installed `playwright-core` version (the image carries
the browser Playwright expects, so no `CHROMIUM_PATH` is needed), and `/data` must be writable by the container user.

**This deployment was not performed during development.** What was exercised is the same split on one machine: the
production web build with no browser available, separate worker processes, a real PostgreSQL server and an S3 API
endpoint (see [TESTING-REPORT.md](TESTING-REPORT.md)). No Vercel project, managed database or cloud bucket was used.

## Archive storage

| `ARCHIVE_STORAGE` | Behaviour |
|---|---|
| `local` | ZIP and reports are moved to `ARCHIVE_DIR` (default `CRAWL_DATA_DIR/_store`). The web app streams them. Web and worker must see the same directory. |
| `s3` | The worker uploads to `s3://$S3_BUCKET/jobs/<id>/…`. A download answers `302` to a pre-signed GET that expires after `DOWNLOAD_URL_TTL_SECONDS` (default 60); reports are proxied through the app with a sandboxing CSP. |

Bucket requirements: **private** (no public read, no public listing); credentials limited to `GetObject`, `PutObject`,
`DeleteObject` on that bucket. Works with AWS S3 and S3-compatible services — for those set `S3_ENDPOINT` (and
`S3_FORCE_PATH_STYLE=0` if the service wants `bucket.host` addressing). Uploads are single `PUT` requests, so the ZIP
size is bounded by the provider's single-PUT limit (5 GB on AWS) — keep `CRAWLER_HARD_MAX_TOTAL_BYTES` below it.
Connection errors and 5xx/429 answers are retried (three attempts); credential and bucket errors are not.

The S3 client is a small built-in Signature V4 implementation (no SDK). How it was verified, and that no real cloud
endpoint was contacted while doing so, is recorded in [TESTING-REPORT.md](TESTING-REPORT.md).

## Chromium

The worker looks for a browser in this order: `CHROMIUM_PATH`, Playwright's own download, then the npm package
`@sparticuz/chromium` if it is installed (it is a dev dependency used by the test suite). `npm run chromium:check`
prints what was found. The crawler launches it with `--no-sandbox` because most containers cannot provide the sandbox's
kernel features; set `CRAWLER_CHROMIUM_SANDBOX=1` where they can (recommended on a VM).

## Embedding in another site

Leave `APP_EMBED_ORIGINS` **unset** in production: pages are then served with `X-Frame-Options: DENY` and
`frame-ancestors 'none'`. Setting it to a list of origins allows exactly those sites to frame the app and switches the
session cookie to `SameSite=None; Secure; Partitioned` so that it works inside the frame. `*` allows any site and exists
only for throw-away preview environments.

## Upgrading from 3.0

1. Deploy the new code, run `npm run db:migrate`.
2. Create accounts (`npm run user:create`) — 3.0 had none; `CRAWLER_AUTH_API_TOKEN` is no longer used.
3. Set `CRAWLER_CREDENTIAL_ENCRYPTION_KEY` if it was not set.
4. Old job directories under `CRAWL_DATA_DIR` are not migrated; delete them.
5. `drizzle-kit push` is no longer part of the workflow (the dev dependency and `drizzle.config.json` were removed).

## Local development

```bash
npm run db:dev          # real PostgreSQL from the embedded-postgres dev dependency; prints DATABASE_URL
npm run db:migrate
npm run user:create -- dev@example.test
npm run dev
```
