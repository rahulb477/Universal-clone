import { handleError, json, readJson } from "@/lib/api";
import { assertSameOrigin, login } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { email, password } → session cookie + CSRF token. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const r = await login(req, await readJson(req, 4096));
    return json({ ok: true, user: { email: r.user.email, role: r.user.role }, csrfToken: r.csrfToken }, { headers: { "set-cookie": r.cookie } });
  } catch (e) {
    return handleError(e);
  }
}
