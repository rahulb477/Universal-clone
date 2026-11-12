import { clientIp, handleError } from "@/lib/api";
import { ApiError, getManager } from "@/lib/crawler/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/crawl — download history. */
export async function GET() {
  try {
    return Response.json({ jobs: await getManager().list() });
  } catch (e) {
    return handleError(e);
  }
}

/** POST /api/crawl — start a crawl. Body: { url, options?, confirmPermission: true } */
export async function POST(req: Request) {
  try {
    let body: { url?: unknown; options?: unknown; confirmPermission?: unknown };
    try {
      body = await req.json();
    } catch {
      throw new ApiError(400, "Invalid JSON body");
    }
    if (body.confirmPermission !== true) {
      throw new ApiError(400, "You must confirm that you own the website or have permission to archive it.");
    }
    const id = await getManager().start(body.url, body.options, clientIp(req));
    return Response.json({ id }, { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}
