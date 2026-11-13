import { handleError, json } from "@/lib/api";
import { clearCredentials, loginSessionsOf, ownedJob, profilesOf } from "@/lib/server/jobs";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET — login profiles of this job (never credentials) and its sign-in sessions. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    const job = await ownedJob(user, (await ctx.params).id);
    return json({ profiles: await profilesOf(user, job.id), loginSessions: await loginSessionsOf(user, job.id) });
  } catch (e) {
    return handleError(e);
  }
}

/** POST / DELETE — remove stored credentials and saved browser sessions, and end the live session. */
async function clear(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    return json(await clearCredentials(user, (await ctx.params).id));
  } catch (e) {
    return handleError(e);
  }
}
export const POST = clear;
export const DELETE = clear;
