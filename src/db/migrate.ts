import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

/**
 * Applies drizzle/*.sql in file-name order. Each file runs in its own transaction and is recorded
 * in schema_migrations, so the command is idempotent and safe to run on every deploy. A session
 * advisory lock stops two deploys from migrating at the same time.
 */
export async function migrate(databaseUrl: string, dir = path.join(process.cwd(), "drizzle")): Promise<{ applied: string[]; skipped: string[] }> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727274001)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) {
        skipped.push(f);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274001)").catch(() => {});
    client.release();
    await pool.end();
  }
  return { applied, skipped };
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  migrate(url).then(
    (r) => {
      console.log(`migrations applied: ${r.applied.length ? r.applied.join(", ") : "none"}; already present: ${r.skipped.length}`);
    },
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
