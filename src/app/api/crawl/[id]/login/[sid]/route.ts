import { handleError, json, readJson } from "@/lib/api";
import { loginAction, loginSession } from "@/lib/server/jobs";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sid: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    const { id, sid } = await ctx.params;
    return json({ session: await loginSession(user, id, sid) });
  } catch (e) {
    return handleError(e);
  }
}

/** POST { action: "input", event } | { action: "confirm" } | { action: "cancel" } */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    const { id, sid } = await ctx.params;
    return json(await loginAction(user, id, sid, await readJson(req, 8192)));
  } catch (e) {
    return handleError(e);
  }
}
