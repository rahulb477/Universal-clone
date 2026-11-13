import { handleError, json } from "@/lib/api";
import { clearedCookie, logout, requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const ctx = await requireUser(req);
    await logout(ctx);
    return json({ ok: true }, { headers: { "set-cookie": clearedCookie() } });
  } catch (e) {
    return handleError(e);
  }
}
