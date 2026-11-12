import { handleError } from "@/lib/api";
import { ApiError, getManager, type JobEvent } from "@/lib/crawler/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-Sent Events stream with live stats and log lines for one crawl. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const mgr = getManager();
    const snap = await mgr.get(id);
    if (!snap) throw new ApiError(404, "Job not found");
    const enc = new TextEncoder();
    let unsub: (() => void) | null = null;
    let keepalive: NodeJS.Timeout | null = null;
    const stream = new ReadableStream({
      start(controller) {
        const send = (type: string, data: unknown) => {
          try {
            controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            /* closed */
          }
        };
        const close = () => {
          if (keepalive) clearInterval(keepalive);
          unsub?.();
          try {
            controller.close();
          } catch {
            /* closed */
          }
        };
        send("snapshot", snap);
        unsub = mgr.subscribe(id, (e: JobEvent) => {
          send(e.type, e.data);
          if (e.type === "done") setTimeout(close, 50);
        });
        if (!unsub) {
          send("done", { status: snap.job.status });
          return close();
        }
        keepalive = setInterval(() => controller.enqueue(enc.encode(": keepalive\n\n")), 15000);
        req.signal.addEventListener("abort", close, { once: true });
      },
      cancel() {
        if (keepalive) clearInterval(keepalive);
        unsub?.();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
    });
  } catch (e) {
    return handleError(e);
  }
}
