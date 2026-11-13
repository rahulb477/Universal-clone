#!/usr/bin/env node
/**
 * Local development database: starts a real PostgreSQL server from the `embedded-postgres`
 * dev dependency (no Docker, no system install) and prints its DATABASE_URL.
 *
 *   node scripts/dev-postgres.mjs            # data in .pgdata, port 54321
 *   PGPORT=5555 PGDATA=/tmp/x node scripts/dev-postgres.mjs
 *
 * Not for production — use a managed PostgreSQL there.
 */
import fs from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const port = Number(process.env.PGPORT || 54321);
const dir = path.resolve(process.env.PGDATA || ".pgdata");
const database = process.env.PGDATABASE || "universal_clone";
const password = process.env.PGPASSWORD || "dev-only-password";
const fresh = !fs.existsSync(path.join(dir, "PG_VERSION"));

const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password, port, persistent: true, onLog: () => {}, onError: (e) => console.error(String(e)) });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(database);
console.log(`DATABASE_URL=postgres://postgres:${password}@127.0.0.1:${port}/${database}`);
console.log("PostgreSQL is running. Press Ctrl+C to stop.");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await pg.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
