import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@/db/migrate";
import * as schema from "@/db/schema";
import { startPostgres, type TestPostgres } from "../setup/postgres";
import { runCli } from "../setup/server";

/**
 * Migrations against a real PostgreSQL server (started from the `embedded-postgres` binaries):
 * fresh install, upgrade of a V3.0 database that already holds data, idempotency, concurrency,
 * rollback of a failing migration, and the constraints the application relies on.
 */

let pg: TestPostgres;
let n = 0;
const fresh = () => pg.createDatabase(`mig_${++n}`);
const tables = async (url: string) => (await pg.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' order by 1", [], url)).map((r) => r.table_name);

/** The schema exactly as V3.0 created it with `drizzle-kit push`. */
const V30_SCHEMA = `CREATE TABLE crawl_jobs (
  id text PRIMARY KEY, url text NOT NULL, status text NOT NULL, options jsonb NOT NULL, stats jsonb, error text, stop_reason text,
  has_zip boolean NOT NULL DEFAULT false, zip_bytes bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz)`;

beforeAll(async () => {
  pg = await startPostgres();
}, 120000);
afterAll(async () => {
  await pg?.stop();
});

describe("migrations", () => {
  it("runs against a real PostgreSQL server", () => {
    expect(pg.version).toMatch(/^PostgreSQL \d+\.\d+/);
  });

  it("creates the complete schema on an empty database and is idempotent", async () => {
    const url = await fresh();
    const first = await migrate(url);
    expect(first.applied).toEqual(["0000_initial.sql", "0001_users_ownership_queue.sql", "0002_admin_setup.sql", "0003_saved_login_profiles.sql"]);
    expect(await tables(url)).toEqual(["admin_setup", "auth_profiles", "crawl_jobs", "job_commands", "job_events", "login_profile_commands", "login_sessions", "rate_events", "saved_login_sessions", "schema_migrations", "target_login_profiles", "user_sessions", "users", "workers"]);
    const second = await migrate(url);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0000_initial.sql", "0001_users_ownership_queue.sql", "0002_admin_setup.sql", "0003_saved_login_profiles.sql"]);
    expect((await pg.query("select name from schema_migrations order by 1", [], url)).map((r: any) => r.name)).toEqual(["0000_initial.sql", "0001_users_ownership_queue.sql", "0002_admin_setup.sql", "0003_saved_login_profiles.sql"]);
  });

  it("the migrated database has exactly the columns the application's schema declares", async () => {
    const url = await fresh();
    await migrate(url);
    const declared = (Object.values(schema) as unknown[]).filter((v) => is(v, PgTable)) as PgTable[];
    expect(declared.length).toBe(13);
    for (const table of declared) {
      const name = getTableName(table);
      const inDb = await pg.query<{ column_name: string; is_nullable: string }>("select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1", [name], url);
      const cols = Object.values(getTableColumns(table));
      expect(inDb.map((c) => c.column_name).sort(), name).toEqual(cols.map((c) => c.name).sort());
      for (const c of cols) expect(inDb.find((d) => d.column_name === c.name)!.is_nullable === "NO", `${name}.${c.name} NOT NULL`).toBe(c.notNull);
    }
  });

  it("upgrades a V3.0 database in place and keeps its rows (which then belong to nobody)", async () => {
    const url = await fresh();
    await pg.query(V30_SCHEMA, [], url);
    await pg.query(`insert into crawl_jobs (id, url, status, options, has_zip, zip_bytes) values ('0123456789abcdef', 'https://old.example/', 'completed', '{"maxPages":10}'::jsonb, true, 1234)`, [], url);
    const r = await migrate(url);
    expect(r.applied).toEqual(["0000_initial.sql", "0001_users_ownership_queue.sql", "0002_admin_setup.sql", "0003_saved_login_profiles.sql"]);
    const row = (await pg.query<any>("select * from crawl_jobs", [], url))[0];
    expect(row).toMatchObject({ id: "0123456789abcdef", url: "https://old.example/", status: "completed", has_zip: true, owner_id: null, mode: "public", resume: false, download_count: 0, storage: null });
    expect(row.options).toEqual({ maxPages: 10 });
    expect(Number(row.zip_bytes)).toBe(1234);
  });

  it("two deploys migrating at the same time do not collide", async () => {
    const url = await fresh();
    const results = await Promise.all([migrate(url), migrate(url), migrate(url)]);
    expect(results.flatMap((r) => r.applied).sort()).toEqual(["0000_initial.sql", "0001_users_ownership_queue.sql", "0002_admin_setup.sql", "0003_saved_login_profiles.sql"]);
    expect(await pg.query("select count(*)::int as n from schema_migrations", [], url)).toEqual([{ n: 4 }]);
  });

  it("the first-administrator marker survives deletion of the account and is unique", async () => {
    const url = await fresh();
    await migrate(url);
    await pg.query("insert into users (id, email, password_hash, role) values ('adm1', 'owner@example.test', 'x', 'admin')", [], url);
    await pg.query("insert into admin_setup (id, user_id) values ('first-admin', 'adm1')", [], url);
    await pg.query("delete from users where id = 'adm1'", [], url);
    expect(await pg.query("select id, user_id from admin_setup", [], url)).toEqual([{ id: "first-admin", user_id: null }]);
    await expect(pg.query("insert into admin_setup (id) values ('first-admin')", [], url)).rejects.toThrow(/admin_setup_pkey/);
  });

  it("a failing migration is rolled back completely and reported; earlier ones stay applied", async () => {
    const url = await fresh();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-mig-"));
    try {
      for (const f of fs.readdirSync("drizzle").filter((f) => f.endsWith(".sql"))) fs.copyFileSync(path.join("drizzle", f), path.join(dir, f));
      fs.writeFileSync(path.join(dir, "0002_broken.sql"), "CREATE TABLE half_done (id text PRIMARY KEY);\nALTER TABLE does_not_exist ADD COLUMN x text;\n");
      await expect(migrate(url, dir)).rejects.toThrow(/Migration 0002_broken\.sql failed: .*does_not_exist/);
      expect(await tables(url)).not.toContain("half_done");
      // 0002_broken sorts after 0002_admin_setup, so that one is applied and 0003 is never reached.
      expect((await pg.query<any>("select name from schema_migrations order by 1", [], url)).map((r) => r.name)).toEqual(["0000_initial.sql", "0001_users_ownership_queue.sql", "0002_admin_setup.sql"]);
      // Fixing the file and re-running applies just that one.
      fs.writeFileSync(path.join(dir, "0002_broken.sql"), "CREATE TABLE half_done (id text PRIMARY KEY);\n");
      expect((await migrate(url, dir)).applied).toEqual(["0002_broken.sql", "0003_saved_login_profiles.sql"]);
      expect(await tables(url)).toContain("half_done");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the command-line tools work: `npm run db:migrate` and `npm run user:create`", async () => {
    const url = await fresh();
    expect(runCli("src/db/migrate.ts", [], { DATABASE_URL: "" }).code).toBe(1);
    const a = runCli("src/db/migrate.ts", [], { DATABASE_URL: url });
    expect(a.code).toBe(0);
    expect(a.out).toContain("migrations applied: 0000_initial.sql, 0001_users_ownership_queue.sql, 0002_admin_setup.sql, 0003_saved_login_profiles.sql; already present: 0");
    expect(runCli("src/db/migrate.ts", [], { DATABASE_URL: url }).out).toContain("migrations applied: none; already present: 4");
    const unreachable = runCli("src/db/migrate.ts", [], { DATABASE_URL: "postgres://postgres:x@127.0.0.1:9/nope" });
    expect(unreachable.code).toBe(1);

    const u = runCli("scripts/create-user.ts", ["Admin@Example.test", "admin"], { DATABASE_URL: url, USER_PASSWORD: "a long enough password" });
    expect(u.code, u.out).toBe(0);
    expect(u.out).not.toContain("a long enough password");
    const row = (await pg.query<any>("select email, role, password_hash from users", [], url))[0];
    expect(row).toMatchObject({ email: "admin@example.test", role: "admin" });
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain("a long enough password");
    const dup = runCli("scripts/create-user.ts", ["admin@example.test"], { DATABASE_URL: url, USER_PASSWORD: "a long enough password" });
    expect(dup.code).toBe(1);
    expect(dup.out).toContain("already exists");
    expect(runCli("scripts/create-user.ts", ["weak@example.test"], { DATABASE_URL: url, USER_PASSWORD: "short" }).code).toBe(1);
  });
});

describe("command-line configuration", () => {
  it("package.json runs the tools the way the tests do", () => {
    const scripts = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    for (const [name, file] of [["worker", "src/worker/main.ts"], ["db:migrate", "src/db/migrate.ts"], ["user:create", "scripts/create-user.ts"]]) expect(scripts[name]).toBe(`node --import ./scripts/load-env.mjs --import tsx ${file}`);
  });

  it("the tools read .env from the working directory; real environment variables win", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-env-"));
    try {
      const run = (env: Record<string, string>) => spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("scripts/load-env.mjs")).href, "-e", "console.log(JSON.stringify([process.env.UC_A, process.env.UC_B]))"], { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8" });
      expect(JSON.parse(run({}).stdout)).toEqual([null, null]); // no .env: nothing happens
      fs.writeFileSync(path.join(dir, ".env"), "# comment\nUC_A=from-file\nUC_B=\"quoted value\"\n");
      expect(JSON.parse(run({}).stdout)).toEqual(["from-file", "quoted value"]);
      expect(JSON.parse(run({ UC_A: "from-environment" }).stdout)).toEqual(["from-environment", "quoted value"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("constraints the application depends on", () => {
  let url: string;
  const q = <T = any>(sql: string, params: unknown[] = []) => pg.query<T>(sql, params, url);
  beforeAll(async () => {
    url = await fresh();
    await migrate(url);
    await q("insert into users (id, email, password_hash) values ('u1', 'a@example.test', 'x'), ('u2', 'b@example.test', 'x')");
  });

  it("email addresses are unique regardless of case", async () => {
    await expect(q("insert into users (id, email, password_hash) values ('u3', 'A@Example.test', 'x')")).rejects.toThrow(/users_email_key/);
  });

  it("a job cannot point at a user that does not exist, and a profile cannot exist without its job and owner", async () => {
    await expect(q("insert into crawl_jobs (id, url, status, options, owner_id) values ('j0', 'https://x.test', 'queued', '{}', 'ghost')")).rejects.toThrow(/foreign key/);
    await q("insert into crawl_jobs (id, url, status, options, owner_id) values ('j1', 'https://x.test', 'queued', '{}', 'u1')");
    await expect(q("insert into auth_profiles (id, job_id, owner_id, position, name, method, login_origin) values ('p0', 'nope', 'u1', 0, 'n', 'form', 'https://x.test')")).rejects.toThrow(/foreign key/);
    await expect(q("insert into auth_profiles (id, job_id, owner_id, position, name, method, login_origin) values ('p0', 'j1', null, 0, 'n', 'form', 'https://x.test')")).rejects.toThrow(/null value/);
  });

  it("deleting a job removes its profiles, sign-in sessions, commands and events; deleting a user removes everything they own", async () => {
    await q("insert into auth_profiles (id, job_id, owner_id, position, name, method, login_origin, secret) values ('p1', 'j1', 'u1', 0, 'n', 'form', 'https://x.test', 'v2.x.y.z')");
    await q("insert into login_sessions (id, job_id, profile_id, owner_id, reason, status, expires_at) values ('l1', 'j1', 'p1', 'u1', 'mfa', 'awaiting-user', now() + interval '10 minutes')");
    await q("insert into job_commands (job_id, type) values ('j1', 'pause')");
    await q(`insert into job_events (job_id, type, data) values ('j1', 'log', '{"message":"hello"}')`);
    await q("delete from crawl_jobs where id = 'j1'");
    for (const t of ["auth_profiles", "login_sessions", "job_commands", "job_events"]) expect(await q(`select count(*)::int as n from ${t}`), t).toEqual([{ n: 0 }]);

    await q("insert into crawl_jobs (id, url, status, options, owner_id) values ('j2', 'https://x.test', 'completed', '{}', 'u2'), ('j3', 'https://x.test', 'completed', '{}', 'u1')");
    await q("insert into user_sessions (id, user_id, expires_at) values ('s2', 'u2', now() + interval '1 hour')");
    await q("insert into auth_profiles (id, job_id, owner_id, position, name, method, login_origin) values ('p2', 'j2', 'u2', 0, 'n', 'manual', 'https://x.test')");
    await q("delete from users where id = 'u2'");
    expect((await q("select id from crawl_jobs order by 1")).map((r) => r.id)).toEqual(["j3"]);
    expect(await q("select count(*)::int as n from user_sessions")).toEqual([{ n: 0 }]);
    expect(await q("select count(*)::int as n from auth_profiles")).toEqual([{ n: 0 }]);
  });

  it("the queue query hands each queued job to exactly one of many concurrent claimers", async () => {
    await q("delete from crawl_jobs");
    for (let i = 0; i < 20; i++) await q("insert into crawl_jobs (id, url, status, options, owner_id, created_at) values ($1, 'https://x.test', 'queued', '{}', 'u1', now() + ($2 || ' milliseconds')::interval)", [`q${String(i).padStart(2, "0")}`, String(i)]);
    // The statement CrawlWorker.claim() runs, issued by 8 competing connections.
    const claim = (worker: string) =>
      q<{ id: string }>(
        `UPDATE crawl_jobs SET status = 'running', worker_id = $1, heartbeat_at = now(), started_at = coalesce(started_at, now())
         WHERE id = (SELECT id FROM crawl_jobs WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`,
        [worker],
      );
    const claimed: string[] = [];
    for (let round = 0; round < 5; round++) {
      const got = await Promise.all(Array.from({ length: 8 }, (_, w) => claim(`w${w}`)));
      claimed.push(...got.flat().map((r) => r.id));
    }
    expect(claimed).toHaveLength(20);
    expect(new Set(claimed).size).toBe(20);
    expect(await q("select count(*)::int as n from crawl_jobs where status = 'queued'")).toEqual([{ n: 0 }]);
    expect(await claim("late")).toEqual([]);
  });
});
