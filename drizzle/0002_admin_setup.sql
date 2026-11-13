-- V3.1.1: one-time first-administrator setup marker.
--
-- The row (id = 'first-admin') is written inside the same transaction that creates the first admin,
-- under an advisory lock. It is what makes first-admin setup permanently disabled, even if the
-- administrator account is later deleted. `user_id` is nulled instead of cascading, so the marker
-- survives account deletion.
--
-- The endpoint also creates this table with IF NOT EXISTS, so a deployment whose migrations have not
-- run yet can still complete setup. This file keeps the schema, the migration ledger and the
-- documentation in agreement.

CREATE TABLE IF NOT EXISTS admin_setup (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
