import { handleError, json, readJson } from "@/lib/api";
import { assertSameOrigin, register } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { email, password, inviteCode? } — only when AUTH_REGISTRATION is "open" or "invite". */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const user = await register(req, await readJson(req, 4096));
    return json({ ok: true, user: { email: user.email } }, { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}
