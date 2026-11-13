import { handleError, json, readJson } from "@/lib/api";
import { clearSavedSession, getSavedProfile, saveRequestCapture } from "@/lib/server/login-profiles";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/login-profiles/:id/session — status only. The stored session never leaves the server. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    const profile = await getSavedProfile(user, (await ctx.params).id);
    return json({ profile: profile, hasSession: profile.hasSession, session: profile.session });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * POST /api/login-profiles/:id/session — import a request captured from the signed-in browser
 * ("Copy as cURL" / "Copy as wget" / a `Cookie:` header) for sites whose login does not survive a
 * headless browser. Body: { capture: string }
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    const body = await readJson(req, 96 * 1024);
    if (typeof body.capture !== "string" || !body.capture.trim()) return json({ error: "Paste the request from your browser's developer tools." }, { status: 400 });
    return json({ profile: await saveRequestCapture(user, id, body.capture) });
  } catch (e) {
    return handleError(e);
  }
}

/** DELETE /api/login-profiles/:id/session — "Forget this login" (keeps the profile itself). */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    return json({ profile: await clearSavedSession(user, (await ctx.params).id) });
  } catch (e) {
    return handleError(e);
  }
}
