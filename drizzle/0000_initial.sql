-- Baseline: the table that V3.0 created with `drizzle-kit push`.
-- IF NOT EXISTS keeps this migration safe on databases that already have it.
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id text PRIMARY KEY,
  url text NOT NULL,
  status text NOT NULL,
  options jsonb NOT NULL,
  stats jsonb,
  error text,
  stop_reason text,
  has_zip boolean NOT NULL DEFAULT false,
  zip_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
