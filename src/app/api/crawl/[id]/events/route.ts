import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { crawlJobs } from "@/db/schema";
import { handleError } from "@/lib/api";
import { eventsAfter, getJob, lastEventId, loginSessionsOf, publicJob } from "@/lib/server/jobs";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Serverless hosts cut a streaming response at the function's time limit; ask for enough to cover SSE_MAX_SECONDS
// (default 280 s). The platform caps this at what the plan allows; the browser reconnects with Last-Event-ID either way.
export const maxDuration = 300;

const POLL_MS = 700;

/**
 * Server-Sent Events for one crawl of the signed-in user. The stream is fed from PostgreSQL (the
 * worker may live in another process or on another machine), supports Last-Event-ID so a client
 * that reconnects misses nothing, and ends itself after SSE_MAX_SECONDS so it fits serverless
 * execution limits — EventSource reconnects automatically.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    const snap = await getJob(user, id);
    const resumeFrom = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after") ?? NaN);
    const maxMs = Math.min(3600, Math.max(10, Number(process.env.SSE_MAX_SECONDS) || 280)) * 1000;
    const enc = new TextEncoder();
    let timer: NodeJS.Timeout | null = null;
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (type: string, data: unknown, eventId?: number) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`${eventId !== undefined ? `id: ${eventId}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          if (timer) clearTimeout(timer);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        req.signal.addEventListener("abort", close, { once: true });

        // Position: after the newest event included in the snapshot, unless the client is resuming.
        let last = Number.isFinite(resumeFrom) && resumeFrom >= 0 ? resumeFrom : 0;
        if (!(Number.isFinite(resumeFrom) && resumeFrom >= 0)) {
          // The snapshot already carries the recent log lines; live delivery starts after them.
          last = await lastEventId(id);
          send("snapshot", snap);
        }
        if (!snap.live) {
          send("done", { status: snap.job.status, error: snap.job.error, zipBytes: snap.job.zipBytes });
          return close();
        }
        const started = Date.now();
        let lastStats = "";
        let lastStatus = snap.job.status;
        let lastLogins = JSON.stringify(snap.loginSessions.map((s) => [s.id, s.status, s.message, s.pageUrl]));
        let beats = 0;
        const poll = async () => {
          if (closed) return;
          try {
            const events = await eventsAfter(id, last);
            let done: unknown = null;
            for (const e of events) {
              last = e.id;
              if (e.type === "done") done = e.data;
              else if (e.type === "log") send("log", e.data, e.id);
            }
            const row = (await db.select().from(crawlJobs).where(and(eq(crawlJobs.id, id), eq(crawlJobs.ownerId, user.id))).limit(1))[0];
            if (!row) {
              send("done", { status: "deleted" });
              return close();
            }
            const stats = JSON.stringify(row.stats ?? null);
            if (row.stats && stats !== lastStats) {
              lastStats = stats;
              send("stats", { ...(row.stats as object), status: row.status });
            }
            if (row.status !== lastStatus) {
              lastStatus = row.status;
              send("status", row.status);
            }
            const logins = await loginSessionsOf(user, id, true);
            const sig = JSON.stringify(logins.map((s) => [s.id, s.status, s.message, s.pageUrl]));
            if (sig !== lastLogins) {
              lastLogins = sig;
              send("login", { sessions: logins });
            }
            const terminal = ["completed", "cancelled", "failed", "interrupted"].includes(row.status);
            if (done || terminal) {
              send("job", publicJob(row));
              send("done", done ?? { status: row.status, error: row.error, zipBytes: row.zipBytes }, last);
              return close();
            }
            if (++beats % 20 === 0) controller.enqueue(enc.encode(": keepalive\n\n"));
            if (Date.now() - started > maxMs) return close();
          } catch {
            /* transient database error: try again on the next tick */
          }
          if (!closed) timer = setTimeout(() => void poll(), POLL_MS);
        };
        void poll();
      },
      cancel() {
        closed = true;
        if (timer) clearTimeout(timer);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
    });
  } catch (e) {
    return handleError(e);
  }
}
