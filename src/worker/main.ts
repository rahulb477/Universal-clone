import http from "node:http";
import path from "node:path";
import { sql } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { databaseErrorCode, databaseFingerprint } from "@/db/diagnostics";
import { migrate } from "@/db/migrate";
import { authenticatedCrawlingEnabled } from "@/lib/crawler/auth";
import { Renderer } from "@/lib/crawler/renderer";
import { storageKind } from "@/lib/server/storage";
import { CrawlWorker } from "./worker";

/**
 * Entry point of the persistent worker process (`npm run worker`).
 * Environment: DATABASE_URL (required), CRAWL_DATA_DIR, ARCHIVE_STORAGE / S3_*, CHROMIUM_PATH,
 * CRAWLER_CREDENTIAL_ENCRYPTION_KEY, WORKER_HEALTH_PORT, WORKER_MIGRATE=1. See docs/DEPLOYMENT.md.
 */
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const fingerprint = databaseFingerprint(process.env.DATABASE_URL);
  console.log(JSON.stringify({ event: "database_identity", component: "worker", fingerprint }));
  const expected = process.env.DATABASE_EXPECTED_FINGERPRINT;
  if (expected && (!fingerprint || expected !== fingerprint)) {
    throw new Error("Database endpoint fingerprint differs from the web app. Compare DATABASE_URL host and database name (including Neon branch/pooler endpoint); do not log the URL.");
  }
  // Resolve the packaged browser (or the explicit operator override), never a fallback chain.
  const helper = path.join(process.cwd(), "scripts", "chromium-env.mjs");
  const { applyChromiumEnv } = (await import(/* webpackIgnore: true */ helper)) as { applyChromiumEnv: () => Promise<{ ok: boolean; reason?: string; version?: string; source?: string }> };
  const chromium = await applyChromiumEnv();
  if (!chromium.ok) {
    // Fail loudly: a worker without a browser cannot run JS-rendered or authenticated crawls.
    if (process.env.WORKER_ALLOW_NO_BROWSER !== "1") throw new Error(`Chromium is not available: ${chromium.reason}`);
    console.warn(`[worker] Chromium is not available (${chromium.reason}); only fast (HTTP-only) crawls will work.`);
  } else {
    const probe = await Renderer.create(false);
    if (!probe) {
      console.error(`[worker] Chromium launch diagnostic:\n${Renderer.lastLaunchDiagnostic}`);
      throw new Error(`Chromium was found but does not start: ${Renderer.lastError}`);
    }
    try {
      const page = await probe.browser.newPage();
      await page.setContent("<p>Chromium ready</p>");
      if (await page.textContent("p") !== "Chromium ready") throw new Error("Browser page check failed");
    } catch (error) {
      console.error("[worker] Chromium page diagnostic:", error);
      throw error;
    } finally {
      await probe.close();
    }
    console.log(`[worker] ${chromium.version} via ${chromium.source}`);
  }
  if (process.env.WORKER_MIGRATE === "1") {
    try {
      const r = await migrate(process.env.DATABASE_URL);
      console.log(`[worker] migrations applied: ${r.applied.join(", ") || "none"}`);
    } catch (error) {
      console.error(JSON.stringify({ event: "migration_failed", code: databaseErrorCode(error), hint: "Check migration state, permissions and database connectivity." }));
      throw new Error("Worker migration failed; see redacted diagnostic above.");
    }
  }
  try {
    await db.execute(sql`select 1`);
    console.log(JSON.stringify({ event: "database_connected", component: "worker" }));
  } catch (error) {
    console.error(JSON.stringify({ event: "database_connection_failed", code: databaseErrorCode(error), hint: "Check DATABASE_URL, TLS, network access and pool capacity." }));
    throw new Error("Worker database connection failed; see redacted diagnostic above.");
  }
  const worker = new CrawlWorker({
    id: process.env.WORKER_ID || undefined,
    info: { chromium: chromium.ok ? chromium.version : null, storage: storageKind(), authenticatedCrawling: authenticatedCrawlingEnabled(), node: process.version },
  });
  await worker.start();

  let server: http.Server | null = null;
  const port = Number(process.env.WORKER_HEALTH_PORT);
  if (port) {
    // Liveness endpoint for the process supervisor. It exposes nothing about jobs.
    server = http.createServer(async (req, res) => {
      if (req.url !== "/healthz") {
        res.writeHead(404).end();
        return;
      }
      try {
        await db.execute(sql`select 1`);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, activeJobs: worker.activeJobs }));
      } catch {
        res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
      }
    });
    server.listen(port, process.env.WORKER_HEALTH_HOST || "0.0.0.0");
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[worker] ${signal} received, saving running crawls…`);
    server?.close();
    await worker.stop().catch((e) => console.error("[worker] stop failed:", e.message));
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error(`[worker] fatal: ${(e as Error).message}`);
  process.exit(1);
});
