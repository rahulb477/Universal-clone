import { handleError } from "@/lib/api";
import { ApiError, getManager } from "@/lib/crawler/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const data = await getManager().get(id);
    if (!data) throw new ApiError(404, "Job not found");
    return Response.json(data);
  } catch (e) {
    return handleError(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await getManager().remove(id);
    return Response.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
