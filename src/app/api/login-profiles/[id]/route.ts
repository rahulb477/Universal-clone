import { handleError, json, readJson } from "@/lib/api";
import { deleteSavedProfile, getSavedProfile, updateSavedProfile } from "@/lib/server/login-profiles";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/login-profiles/:id — one profile of the signed-in user (never its session). */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    return json({ profile: await getSavedProfile(user, (await ctx.params).id) });
  } catch (e) {
    return handleError(e);
  }
}

/** PATCH /api/login-profiles/:id { name?, loginUrl?, authenticatedSelector? } */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    return json({ profile: await updateSavedProfile(user, id, await readJson(req, 8192)) });
  } catch (e) {
    return handleError(e);
  }
}

/** DELETE /api/login-profiles/:id — removes the profile, its session and anything that pointed at it. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    return json(await deleteSavedProfile(user, (await ctx.params).id));
  } catch (e) {
    return handleError(e);
  }
}
