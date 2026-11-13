import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const globalForDb = globalThis as typeof globalThis & { __ucPool?: Pool; __ucDb?: NodePgDatabase };

/**
 * The pool is created on first use, not at import time, so `next build` does not need a database
 * (or a placeholder DATABASE_URL). A missing DATABASE_URL fails the first query with a clear error.
 */
export function getPool(): Pool {
  if (!globalForDb.__ucPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    const max = Number(process.env.DATABASE_POOL_MAX) || 10;
    const ssl = process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: true } : process.env.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false } : undefined;
    globalForDb.__ucPool = new Pool({ connectionString: url, max, ssl, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    // An idle client dropping its connection must not crash the process.
    globalForDb.__ucPool.on("error", (e) => console.error("[db] idle client error:", e.message));
  }
  return globalForDb.__ucPool;
}

function getDb(): NodePgDatabase {
  if (!globalForDb.__ucDb) globalForDb.__ucDb = drizzle(getPool());
  return globalForDb.__ucDb;
}

export const db: NodePgDatabase = new Proxy({} as NodePgDatabase, {
  get(_t, prop) {
    const target = getDb() as unknown as Record<string | symbol, unknown>;
    const v = target[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  },
});

export async function closeDb() {
  const p = globalForDb.__ucPool;
  globalForDb.__ucPool = undefined;
  globalForDb.__ucDb = undefined;
  await p?.end();
}
