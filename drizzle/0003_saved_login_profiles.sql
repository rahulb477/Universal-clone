-- V3.2: reusable "Login with Browser" profiles.
--
-- A saved login profile is an owner-scoped, origin-locked browser session that can be attached to
-- later crawls (the HTTrack-style "Log in with a browser" → "Use This Login" → "Start download"
-- flow). It is deliberately separate from `auth_profiles`, which keeps per-crawl copy of a login
-- and is wiped when that crawl ends.
--
-- Security model
--   * `target_login_profiles` holds only metadata (name, domain, selector). No secrets.
--   * `saved_login_sessions` holds the Playwright storage state as an AES-256-GCM envelope whose
--     additional authenticated data binds it to the profile id, its owner and its target origin.
--     A row copied onto another profile/owner/origin fails to decrypt.
--   * Both tables cascade from `users`, so deleting an account removes every profile and session.

CREATE TABLE target_login_profiles (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Host (plus non-default port) the profile may be used for. Never a bare suffix match.
  target_host text NOT NULL,
  target_origin text NOT NULL,
  -- 1 = also allow subdomains of target_host (e.g. app.example.com for example.com).
  match_subdomains boolean NOT NULL DEFAULT false,
  start_url text NOT NULL,
  login_url text,
  -- Optional element that is only visible when signed in; used to validate "Use This Login".
  authenticated_selector text,
  -- Masked account identifier, e.g. "al***@example.com". Never the full value.
  username_hint text NOT NULL DEFAULT '',
  -- active | needs-request-capture | session-expired | session-rejected | login-failed
  status text NOT NULL DEFAULT 'active',
  status_message text,
  last_used_at timestamptz,
  use_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX target_login_profiles_owner_idx ON target_login_profiles (owner_id, created_at DESC);
CREATE INDEX target_login_profiles_origin_idx ON target_login_profiles (owner_id, target_host);

-- One captured browser session per profile. Metadata is readable; `state` is encrypted at rest.
CREATE TABLE saved_login_sessions (
  profile_id text PRIMARY KEY REFERENCES target_login_profiles(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state text NOT NULL,
  cookie_count integer NOT NULL DEFAULT 0,
  origin_count integer NOT NULL DEFAULT 0,
  captured_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_validated_at timestamptz,
  -- Set when the site rejected the session or the user asked to forget it.
  invalidated_at timestamptz,
  invalidated_reason text
);

-- Per-crawl copy of a saved profile: which reusable profile (if any) a job's login came from.
ALTER TABLE auth_profiles
  ADD COLUMN saved_profile_id text REFERENCES target_login_profiles(id) ON DELETE SET NULL;

-- Interactive "Login with Browser" sessions can be started for a reusable profile, outside any crawl.
-- They reuse login_sessions (same encrypted frame pipeline) with job_id / profile_id left NULL.
ALTER TABLE login_sessions
  ALTER COLUMN job_id DROP NOT NULL,
  ALTER COLUMN profile_id DROP NOT NULL,
  ADD COLUMN saved_profile_id text REFERENCES target_login_profiles(id) ON DELETE CASCADE,
  -- login-browser | crawl
  ADD COLUMN scope text NOT NULL DEFAULT 'crawl';
CREATE INDEX login_sessions_saved_profile_idx ON login_sessions (saved_profile_id, created_at DESC);

-- Web -> worker commands for reusable-profile sign-in sessions. Separate from job_commands because
-- these exist outside any crawl job (job_id is mandatory there).
CREATE TABLE login_profile_commands (
  id bigserial PRIMARY KEY,
  sid text NOT NULL,
  saved_profile_id text NOT NULL REFERENCES target_login_profiles(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- open | input | confirm | cancel
  type text NOT NULL,
  -- Encrypted when it can carry what the user typed.
  payload text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  result text
);
CREATE INDEX login_profile_commands_pending_idx ON login_profile_commands (id) WHERE processed_at IS NULL;
