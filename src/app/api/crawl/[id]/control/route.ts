import { handleError } from "@/lib/api";
import { ApiError, getManager } from "@/lib/crawler/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { action: "pause" | "resume" | "cancel" } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const mgr = getManager();
    if (body.action === "resume") await mgr.resume(id);
    else if (body.action === "pause" || body.action === "cancel") mgr.control(id, body.action);
    else throw new ApiError(400, "action must be pause, resume or cancel");
    return Response.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
