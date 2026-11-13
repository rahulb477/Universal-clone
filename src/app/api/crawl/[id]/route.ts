import { handleError, json } from "@/lib/api";
import { getJob, removeJob } from "@/lib/server/jobs";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    return json(await getJob(user, (await ctx.params).id));
  } catch (e) {
    return handleError(e);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    await removeJob(user, (await ctx.params).id);
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
