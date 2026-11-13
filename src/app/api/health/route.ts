import { sql } from "drizzle-orm";
import { db } from "@/db";
import { workerMode } from "@/lib/server/config";
import { ensureInlineWorker } from "@/lib/server/inline-worker";
import { workerOnline } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness for load balancers. Deliberately exposes nothing beyond "database reachable / worker seen". */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    if (workerMode() === "inline") ensureInlineWorker();
    return Response.json({ ok: true, worker: (await workerOnline()) ? "online" : "offline" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
