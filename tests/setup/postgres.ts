import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { migrate } from "@/db/migrate";

export interface TestPostgres {
  /** Connection string of a freshly created, empty database. */
  url: string;
  port: number;
  version: string;
  /** Creates another empty database on the same server. */
  createDatabase(name: string): Promise<string>;
  migrate(url?: string): ReturnType<typeof migrate>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[], url?: string): Promise<T[]>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts a real PostgreSQL server (the `embedded-postgres` npm package ships the official binaries)
 * in a temporary directory. This is an actual database process, not a mock and not a placeholder URL.
 */
export async function startPostgres(dbName = "universal_clone_test"): Promise<TestPostgres> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "test-only-password", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const urlFor = (name: string) => `postgres://postgres:test-only-password@127.0.0.1:${port}/${name}`;
  await pg.createDatabase(dbName);
  const url = urlFor(dbName);
  const query = async <T,>(sql: string, params: unknown[] = [], target = url): Promise<T[]> => {
    const c = new Client({ connectionString: target });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows as T[];
    } finally {
      await c.end();
    }
  };
  const version = (await query<{ v: string }>("select version() as v"))[0].v;
  return {
    url,
    port,
    version,
    async createDatabase(name: string) {
      await pg.createDatabase(name);
      return urlFor(name);
    },
    migrate: (target = url) => migrate(target),
    query,
    async stop() {
      await pg.stop().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
