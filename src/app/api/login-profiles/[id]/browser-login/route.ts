import { handleError, json } from "@/lib/api";
import { closeBrowserLogins, startBrowserLogin } from "@/lib/server/login-profiles";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/login-profiles/:id/browser-login — open the isolated browser on the target site.
 * Body (optional): { entryUrl } — must be on the profile's site.
 * Returns the sign-in window the UI shows; the worker opens the real browser.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    const text = await req.text();
    let body: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text);
        body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return json({ error: "Invalid JSON body" }, { status: 400 });
      }
    }
    return json({ session: await startBrowserLogin(user, id, body) }, { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}

/** DELETE /api/login-profiles/:id/browser-login — close any open window of this profile. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    return json(await closeBrowserLogins(user, (await ctx.params).id));
  } catch (e) {
    return handleError(e);
  }
}

