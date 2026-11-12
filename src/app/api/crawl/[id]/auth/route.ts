import { AuthConfigurationError, assertAuthApiToken } from "@/lib/crawler/auth";
import { ApiError, getManager } from "@/lib/crawler/manager";
import { handleError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST with the provisioned auth token removes encrypted credentials and cancels the live session. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertAuthApiToken(req);
    const { id } = await ctx.params;
    const job = await getManager().get(id);
    if (!job) throw new ApiError(404, "Job not found");
    await getManager().clearCredentials(id);
    return Response.json({ ok: true, credentialsRemoved: true, activeSessionCancelled: job.live });
  } catch (error) {
    if (error instanceof AuthConfigurationError) return Response.json({ error: error.message }, { status: error.status });
    return handleError(error);
  }
}
