import { handleError, json, readJson } from "@/lib/api";
import { controlJob } from "@/lib/server/jobs";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { action: "pause" | "resume" | "cancel" } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser(req);
    const body = await readJson(req, 1024);
    const r = await controlJob(user, (await ctx.params).id, body.action);
    return json({ ok: true, ...r });
  } catch (e) {
    return handleError(e);
  }
}
