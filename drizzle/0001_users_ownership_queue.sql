-- V3.1: application users, job ownership, the web <-> worker queue, encrypted
-- credential / browser-session storage, interactive sign-in sessions, download metadata.

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user',
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- id = SHA-256 of the session token; the token itself is only ever in the user's cookie.
CREATE TABLE user_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

ALTER TABLE crawl_jobs
  ADD COLUMN owner_id text REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN mode text NOT NULL DEFAULT 'public',
  ADD COLUMN resume boolean NOT NULL DEFAULT false,
  ADD COLUMN worker_id text,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN storage text,
  ADD COLUMN storage_key text,
  ADD COLUMN zip_sha256 text,
  ADD COLUMN zip_entries integer,
  ADD COLUMN download_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_downloaded_at timestamptz;
-- Rows created before ownership existed have owner_id NULL and are visible to nobody.
CREATE INDEX crawl_jobs_owner_idx ON crawl_jobs (owner_id, created_at DESC);
CREATE INDEX crawl_jobs_queue_idx ON crawl_jobs (status, created_at);

-- One login profile of one job. `secret` and `session_state` are AES-256-GCM envelopes bound to the row id.
CREATE TABLE auth_profiles (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position integer NOT NULL,
  name text NOT NULL,
  method text NOT NULL,
  login_origin text NOT NULL,
  username_hint text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'waiting-for-credentials',
  secret text,
  session_state text,
  session_saved_at timestamptz,
  session_expires_at timestamptz,
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_profiles_job_idx ON auth_profiles (job_id, position);

-- A human-driven sign-in (manual login / MFA) that the worker is holding open.
CREATE TABLE login_sessions (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES auth_profiles(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  status text NOT NULL,
  message text,
  page_url text,
  page_title text,
  frame text,
  frame_seq integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE INDEX login_sessions_job_idx ON login_sessions (job_id, created_at DESC);

-- Web -> worker commands. `payload` is encrypted when it can carry user input.
CREATE TABLE job_commands (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  result text
);
CREATE INDEX job_commands_pending_idx ON job_commands (job_id, id) WHERE processed_at IS NULL;

-- Worker -> web event log (live log lines, status changes, completion).
CREATE TABLE job_events (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events (job_id, id);

CREATE TABLE workers (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  info jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Sliding-window rate limiting that works across stateless web instances.
CREATE TABLE rate_events (
  id bigserial PRIMARY KEY,
  bucket text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_events_bucket_idx ON rate_events (bucket, at);
