import { handleError } from "@/lib/api";
import { ApiError } from "@/lib/server/errors";
import { ownedJob, REPORT_FILES } from "@/lib/server/jobs";
import { getStore, reportKey } from "@/lib/server/storage";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves a whitelisted report file of a job the user owns. Report HTML is sandboxed with a strict CSP. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; file: string }> }) {
  try {
    const { user } = await requireUser(req);
    const { id, file } = await ctx.params;
    const type = Object.prototype.hasOwnProperty.call(REPORT_FILES, file) ? REPORT_FILES[file] : undefined;
    if (!type) throw new ApiError(404, "Unknown report file");
    const row = await ownedJob(user, id);
    const obj = await getStore().get(reportKey(row.id, file));
    if (!obj) throw new ApiError(404, "Report not available");
    return new Response(obj.body, {
      headers: {
        "content-type": type,
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store, private",
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
