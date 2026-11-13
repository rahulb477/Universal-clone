import { handleError } from "@/lib/api";
import { loginFrame } from "@/lib/server/jobs";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Latest screenshot of the isolated sign-in browser. Only the owner of the job can read it. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  try {
    const { user } = await requireUser(req);
    const { id, sid } = await ctx.params;
    const frame = await loginFrame(user, id, sid);
    // The owner's panel polls this: "nothing to show" (not rendered yet, or the sign-in just ended) is not an error.
    // Unknown or foreign sessions are a 404 from loginFrame().
    if (!frame) return new Response(null, { status: 204, headers: { "cache-control": "no-store, private" } });
    return new Response(new Uint8Array(frame.jpeg), {
      headers: { "content-type": "image/jpeg", "cache-control": "no-store, private", "x-frame-seq": String(frame.seq), "x-content-type-options": "nosniff" },
    });
  } catch (e) {
    return handleError(e);
  }
}
