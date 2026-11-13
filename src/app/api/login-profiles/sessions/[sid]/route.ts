import { handleError, json, readJson } from "@/lib/api";
import { browserLoginAction, getBrowserLogin } from "@/lib/server/login-profiles";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sid: string }> };

/** GET — the state of one "Login with Browser" window (no session material). */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    return json(await getBrowserLogin(user, (await ctx.params).sid));
  } catch (e) {
    return handleError(e);
  }
}

/** POST { action: "input", event } | { action: "confirm" } | { action: "cancel" } */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    return json(await browserLoginAction(user, (await ctx.params).sid, await readJson(req, 8192)));
  } catch (e) {
    return handleError(e);
  }
}
