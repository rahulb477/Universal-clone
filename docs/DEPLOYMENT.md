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
npm ci                                        # installs the committed lockfile (npm 11 / Node 22 — see Toolchain)
openssl rand -base64 32                       # → CRAWLER_CREDENTIAL_ENCRYPTION_KEY (same value for web and worker)
npm run db:migrate                            # creates/updates the schema; safe to run on every deploy
USER_PASSWORD='…' npm run user:create -- you@example.com admin   # or omit USER_PASSWORD and type it on stdin
```

No terminal? Create the **first** administrator in the browser instead — set `ADMIN_SETUP_KEY` and open
`/setup-admin` (see [ADMIN-SETUP.md](ADMIN-SETUP.md)).

* `npm run db:migrate` applies the SQL files in `drizzle/` in order, each in its own transaction, and records them in
  `schema_migrations`. It takes a PostgreSQL advisory lock, so parallel deploys do not collide. A database created by
  version 3.0 (`drizzle-kit push`) is upgraded in place; its existing rows have no owner and are therefore invisible to
  every account (delete them or assign `owner_id` by hand).
* **First administrator without a terminal.** Set `ADMIN_SETUP_KEY` (≥ 32 random characters) in the
  environment and open `/setup-admin`. The page creates one administrator with `role = 'admin'`, using the
  same `users` table, scrypt hashing and sign-in flow as every other account. Setup then disables itself
  permanently; remove the variable afterwards. Details, recovery and troubleshooting:
  [ADMIN-SETUP.md](ADMIN-SETUP.md).
* Registration is **closed** by default: accounts exist only when an operator creates them. `AUTH_REGISTRATION=invite`
  plus `AUTH_INVITE_CODE` (≥ 16 characters) or `AUTH_REGISTRATION=open` enable self-service sign-up.
* **`package-lock.json` is committed and must stay committed.** Deployments install with `npm ci`, which installs
  exactly the locked tree and never re-resolves it. After changing a dependency, regenerate the lockfile with npm 11
  (`npm install --package-lock-only`) and commit both files in the same change — see
  [Toolchain and reproducible installs](#toolchain-and-reproducible-installs).
* **Node.js 22 and npm 11** are the supported toolchain (`engines`, `.nvmrc`, `.node-version`, `.tool-versions`,
  `packageManager`). `npm install` on old npm 10 releases can die with npm's own
  `Cannot read properties of null (reading 'edgesOut')`; `npm ci` from the committed lockfile does not, and
  `scripts/check-toolchain.mjs` (wired as `preinstall`) stops the install with an explanation instead of a stack trace.
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
bucket). Add `ADMIN_SETUP_KEY` (≥ 32 random characters) **temporarily** if you want to create the first
administrator from the browser at `https://<your-deployment>/setup-admin`, then delete the variable and
redeploy — see “First administrator in the browser” below. `CRAWLER_WORKER_MODE` defaults to `external` there. Function limits to keep in mind: the live-update stream
closes after `SSE_MAX_SECONDS` (default 280) and the browser reconnects where it left off, so set the function's
maximum duration to at least that or lower the variable to fit your plan.

**Worker (any host that keeps a process running: a VM, Fly.io, Railway, Render, ECS, a Kubernetes Deployment, or
Hostless Cloud — see [Hostless Cloud](#hostless-cloud--worker-deployment)):**

```bash
npm ci
npm run chromium:install                      # Chromium + its system libraries (falls back to the npm package)
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
FROM node:22-bookworm
WORKDIR /app
# `scripts/` comes first: package.json's `preinstall` hook (scripts/check-toolchain.mjs) runs during npm ci.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run chromium:install
ENV NODE_ENV=production CRAWL_DATA_DIR=/data
CMD ["node", "--import", "./scripts/load-env.mjs", "--import", "tsx", "src/worker/main.ts"]
```

`npm ci` installs the committed lockfile, and `playwright-core install` adds the browser that this
`playwright-core` version expects plus the system libraries it needs (no `CHROMIUM_PATH` needed). `/data` must be a
volume writable by the container user and `CRAWL_DATA_DIR` must point at it. If you prefer a Playwright-provided image
instead, its tag must match the installed `playwright-core` version.

**This deployment was not performed during development.** What was exercised is the same split on one machine: the
production web build with no browser available, separate worker processes, a real PostgreSQL server and an S3 API
endpoint (see [TESTING-REPORT.md](TESTING-REPORT.md)). No Vercel project, managed database or cloud bucket was used.

### First administrator in the browser (Vercel, no terminal)

1. **Settings → Environment Variables → Add**: key `ADMIN_SETUP_KEY`, value = a random 32+ character
   secret (Production ticked). **Save**, then **Deployments → ⋯ → Redeploy** — new variables only reach a
   new deployment.
2. On your phone open `https://universal-clone7.vercel.app/setup-admin`, fill in email, a strong password
   (12+ characters, three character classes, not containing the email local part) twice, and the setup key.
   **Create administrator**.
3. **Continue to sign in** and sign in at `/` with the new account. The account has `role = 'admin'`; it can
   open `/api/admin/overview`, which ordinary accounts cannot.
4. **Remove `ADMIN_SETUP_KEY`** and redeploy. `/setup-admin` then reports that setup is disabled, and
   `POST /api/auth/setup` answers `503`. Setup also stays disabled on its own: the completion marker row
   (`admin_setup`) makes it answer `409` from then on, even if the account is later deleted.

No terminal, no `npm run` and no database client is needed. Steps, screenshots-in-words, recovery and
troubleshooting table: [ADMIN-SETUP.md](ADMIN-SETUP.md).

## Toolchain and reproducible installs

The dependency tree is resolved once, on purpose: **`package-lock.json` is committed** (it used to be git-ignored) and
every automated build installs with `npm ci`.

| Piece | Value | Where |
|---|---|---|
| Node.js | `22` (supported: `>=20.18.1 <25`) | `engines.node`, `.nvmrc`, `.node-version`, `.tool-versions` (`22.22.3`) |
| npm | `11.21.2` (minimum `>=10.9.0`) | `engines.npm`, `packageManager`, `.tool-versions`, `volta` |
| Install | `npm ci` | `hostless.yaml`, container example, CI |

`npm ci` exists for exactly this situation: it installs only what the lockfile names and never rebuilds the ideal
dependency tree. Verify it locally with `npm ci && npm run typecheck`.

### Why builds used to fail with `Cannot read properties of null (reading 'edgesOut')`

That message is a crash inside npm's dependency resolver (`@npmcli/arborist`), not a problem with the project's code or
with any single dependency version. Arborist builds a virtual tree in which each dependency is an edge pointing at the
node that provides it. Before npm 11.6 it did not reliably guard the case where a provider node is deduplicated or
pruned away and an edge still points at the empty slot; when it then walks a **peer** set, it reads `.edgesOut` from
`null` and throws a raw `TypeError` that exits the install with code 1
([npm/cli#9787](https://github.com/npm/cli/issues/9787)).

Two things in this repository made that reachable and made it look random:

1. **No lockfile was committed**, so every build re-resolved the whole graph from the registry. Peer sets that resolve
   one day can stop resolving the next, without a single change in this repository.
2. **`vitest@5` pulls in a large optional peer set** (`vite`, `jsdom`, `@vitest/*`, `@vitest/browser-playwright`).
   That is the peer graph npm 10 crashes on. It is a dev dependency, but `npm install` resolves dev dependencies even
   when it does not install them (`--omit=dev` included), so the worker build hit it too.

`npm ci` never enters that code path, and npm 11.6+ guards it. Both fixes are in place here, and the toolchain is
pinned so a build image cannot quietly go back to an npm that crashes.

If an install still fails this way (an install that ignores the lockfile, for example), the fix is not
`--force` or `--legacy-peer-deps`: use `npm ci`, or `npx npm@11 install` once and commit the lockfile it writes.

## Hostless Cloud — worker deployment

The worker is a **long-running background process** (`npm run worker`): it claims jobs from PostgreSQL, starts
Chromium and uploads archives. It is not a web app, so deploy it on Hostless as a **Standalone worker**
(**Workers → Create worker → Standalone**), from this repository. A Hostless *App* for the Next.js web tier is a
separate resource with its own settings; the web tier needs no browser and no `npm run worker`.

The repository ships the configuration in [`hostless.yaml`](../hostless.yaml), so the dashboard fields below only need
checking — Hostless applies the file on every deployment and reconciles the `workers` list with it.

| Hostless setting | Value |
|---|---|
| Type | **Standalone worker** |
| Build system | **Detect automatically** (Railpack) — no Dockerfile |
| Working directory | `/` |
| Build context directory | `/` |
| Build command | `npm ci --no-audit --no-fund && npm run chromium:install` |
| Start command | `npm run worker` |
| Post build command | *leave empty* |
| Health check | `http`, path `/healthz`, interval `10` s (only if the resource offers health checks) |
| Replicas | `1` (see “Disk”, below) |
| CPU / memory per replica | min `0.5` vCPU / `1024` MB, max `2` vCPU / `4096` MB |
| Persistent volume | mount at `/data`, then set `CRAWL_DATA_DIR=/data` |

`npm ci` installs the committed lockfile. `npm run chromium:install` downloads the browser this `playwright-core`
version expects, together with the system libraries it needs, and falls back to the npm-packaged
`@sparticuz/chromium` (a regular dependency) when Playwright's download is blocked. It verifies the result and fails the
build if no browser is usable, so the worker never starts half-configured with `Chromium is not available: …`.

**Environment variables** (Hostless **Settings → Environment**, all required unless marked):

| Variable | Value |
|---|---|
| `DATABASE_URL` | the same PostgreSQL database the web app uses |
| `DATABASE_SSL` | `require` when the provider needs TLS |
| `CRAWLER_CREDENTIAL_ENCRYPTION_KEY` | the same 32-byte key as the web app (`openssl rand -base64 32`) |
| `CRAWLER_WORKER_MODE` | `external` |
| `ARCHIVE_STORAGE` | `s3` with `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (`S3_ENDPOINT` for S3-compatible services) — or `local` with `CRAWL_DATA_DIR` on the mounted volume |
| `CRAWL_DATA_DIR` | `/data` (the volume mount path) — scratch space for one crawl |
| `WORKER_HEALTH_PORT` | `8080`, so `GET /healthz` answers for the health check |
| `WORKER_MIGRATE` | `1` once, if the web app does not migrate on its own (see below) |
| `NODE_VERSION` | `22` — optional on Hostless; `engines.node` and `.nvmrc` already select it |

Never put `PORT` in the worker environment: it is a web-app variable, and the worker’s own port is
`WORKER_HEALTH_PORT`.

**If Playwright's browser cannot be downloaded during the build.** The image then runs the npm-packaged
`@sparticuz/chromium`, which ships a Chromium build plus its shared libraries. That package is a **dependency**, so it
survives an install that omits dev dependencies (`npm ci --omit=dev`, the Railpack default for production images).

**Build vs. runtime.** No `next build` is needed — the worker runs TypeScript directly through `tsx`. A Hostless App
deployed from the same repository, however, must build the web tier: build command `npm ci && npm run build`,
start command `npm start`.

**Deployment steps**

1. **Workers → Create worker → Standalone**, choose this repository and branch.
2. Keep **Detect automatically**; check the build and start commands against the table (Hostless reads `hostless.yaml`
   on the first deployment, so they are normally already correct).
3. Add the environment variables above. Copy `DATABASE_URL` and `CRAWLER_CREDENTIAL_ENCRYPTION_KEY` from the web app —
   they must be identical on both.
4. Create and attach a volume mounted at `/data` if you use `ARCHIVE_STORAGE=local`.
5. **Create worker** and follow the log. Success looks like:

   ```
   [worker] Chromium 153.0.8010.0 via playwright
   [worker crawl-worker-…] started (max 5 concurrent jobs, storage: s3)
   ```

   The web app then reports `{"ok":true,"worker":"online"}` on `GET /api/health`.

**First deploy on an empty database.** If the web app is not deployed yet, run the schema once with `WORKER_MIGRATE=1`
(apply the migrations at start), or run `npm run db:migrate` once from any machine with `DATABASE_URL` set. Leave
`WORKER_MIGRATE` unset afterwards; every replica migrating on each restart is pointless work.

**Disk and replicas.** `CRAWL_DATA_DIR` is scratch space for one crawl and must survive a worker restart for *Resume*
to continue where it stopped. The root filesystem of a Hostless workload is read-only, so always mount the volume and
point `CRAWL_DATA_DIR` at it. Jobs are claimed with `SELECT … FOR UPDATE SKIP LOCKED`, so several replicas are safe, but
each replica needs its own writable scratch space — keep `replicas: 1` unless they share the volume.

**Shutdown.** Hostless sends `SIGTERM` on redeploy and restart. The worker saves running crawls, marks them
`interrupted` and exits 0. Start it through `npm run worker` exactly as written: a wrapper that forks a child (for
example the `tsx` CLI) would take the signal instead of the worker, leaving a crawl running with nothing saved.

**Not verified.** No Hostless deployment was performed while preparing this document; no account, project or volume was
created. What was verified locally is the same toolchain and commands from a clean checkout: `npm ci`, `npm run
typecheck`, `npm run build`, `npm run worker` against a real PostgreSQL (`[worker] started …`, `GET /healthz` → `200`)
and a clean `SIGTERM` shutdown. Hostless was only used as documented by its own docs (`hostless.yaml`,
Standalone workers, Railpack builds).

**If the build fails on Hostless**

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot read properties of null (reading 'edgesOut')` | an install that ignored the lockfile (for example `npm install` instead of `npm ci`) resolved `vitest@5`'s peer set on an npm older than 11.6 | use the build command above; make sure `package-lock.json` reached the build (it must not be git-ignored) |
| `npm ci can only install packages when your package.json and package-lock.json … are in sync` (EUSAGE) | `package.json` changed without regenerating the lockfile | `npm install --package-lock-only` with npm 11, commit both files |
| `Chromium is not available: …` at start | the build skipped `npm run chromium:install`, or dev dependencies were pruned along with the npm-packaged browser | keep the build command as documented, or set `CHROMIUM_PATH` to a browser in the image |
| Worker starts, then exits with `DATABASE_URL is required` | environment variables not applied | add them in **Settings → Environment** and redeploy |
| `object storage upload failed: HTTP 403` | wrong bucket or credentials | fix `S3_*`; this fails loudly rather than storing nothing |
| Unhealthy / restarted repeatedly | health check pointed at `/` instead of `/healthz`, or `WORKER_HEALTH_PORT` unset | set the path to `/healthz` and the port to `8080` |

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
`@sparticuz/chromium` — a regular **dependency** (not a dev dependency) precisely so it survives an install that omits
dev dependencies. `npm run chromium:check` prints what was found.

`npm run chromium:install` is the build step: it tries `playwright-core install --with-deps chromium` (browser plus the
OS libraries), then `playwright-core install chromium` if the image already has the libraries, and finally falls back to
the npm-packaged Chromium. It then verifies the result with the worker's own resolver, so a build without a usable
browser fails at build time rather than at the first crawl. If Playwright's own download cannot be reached (a build
network that only allows the npm registry), the npm-packaged Chromium is what runs.

The crawler launches the browser with `--no-sandbox` because most containers cannot provide the sandbox's kernel
features; set `CRAWLER_CHROMIUM_SANDBOX=1` where they can (recommended on a VM).

## Embedding in another site

Leave `APP_EMBED_ORIGINS` **unset** in production: pages are then served with `X-Frame-Options: DENY` and
`frame-ancestors 'none'`. Setting it to a list of origins allows exactly those sites to frame the app and switches the
session cookie to `SameSite=None; Secure; Partitioned` so that it works inside the frame. `*` allows any site and exists
only for throw-away preview environments.

## Upgrading from 3.0

1. Deploy the new code, run `npm run db:migrate` (adds `0002_admin_setup.sql`, a one-row marker table).
2. Create accounts (`npm run user:create`) — 3.0 had none; `CRAWLER_AUTH_API_TOKEN` is no longer used.
3. Set `CRAWLER_CREDENTIAL_ENCRYPTION_KEY` if it was not set.
4. Old job directories under `CRAWL_DATA_DIR` are not migrated; delete them.
5. `drizzle-kit push` is no longer part of the workflow (the dev dependency and `drizzle.config.json` were removed).

## Upgrading to 3.1 (saved logins)

1. Deploy the new code, run `npm run db:migrate` — on a fresh database it applies four files
   (`0000_initial.sql`, `0001_users_ownership_queue.sql`, `0002_admin_setup.sql`, `0003_saved_login_profiles.sql`);
   an existing 3.0 database only gets `0003`. It only **adds** tables and indexes
   (`target_login_profiles`, `saved_login_sessions`, `login_profile_commands`) and never rewrites existing rows.
2. `CRAWLER_CREDENTIAL_ENCRYPTION_KEY` must be identical on the web app and the worker; saved sessions are sealed with
   it (AES-256-GCM, bound to profile + owner + site). Rotating it makes existing saved logins unreadable — they show as
   `session-expired` and users sign in again; nothing else breaks.
3. Optional tuning: `CRAWLER_LOGIN_BROWSER_MINUTES`, `CRAWLER_SAVED_SESSION_TTL_HOURS`,
   `CRAWLER_MAX_SAVED_PROFILES`.
4. The worker needs no new network exposure: all traffic still goes through PostgreSQL. A web tier on Vercel keeps
   working in `CRAWLER_WORKER_MODE=external`, and the “Login with Browser” button opens windows on whichever worker is
   heart-beating.

## Local development

```bash
npm run db:dev          # real PostgreSQL from the embedded-postgres dev dependency; prints DATABASE_URL
npm run db:migrate
npm run user:create -- dev@example.test
npm run dev
```
