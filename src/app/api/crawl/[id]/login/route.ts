import { handleError, json } from "@/lib/api";
import { loginSessionsOf, ownedJob } from "@/lib/server/jobs";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — sign-in sessions of this job that are waiting for the user. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser(req);
    const job = await ownedJob(user, (await ctx.params).id);
    return json({ sessions: await loginSessionsOf(user, job.id, true) });
  } catch (e) {
    return handleError(e);
  }
}
