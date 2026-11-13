import { handleError } from "@/lib/api";
import { browserLoginFrame } from "@/lib/server/login-profiles";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sid: string }> };

/**
 * The live picture of a "Login with Browser" window (JPEG, about one frame per second). Decrypted
 * only for the window's owner; the browser itself is never exposed to the network.
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { user } = await requireUser(req);
    const frame = await browserLoginFrame(user, (await ctx.params).sid);
    if (!frame) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    return new Response(new Uint8Array(frame.jpeg), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "no-store, no-transform",
        "x-frame-seq": String(frame.seq),
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
