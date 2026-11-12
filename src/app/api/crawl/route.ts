import { clientIp, handleError } from "@/lib/api";
import { ApiError, getManager } from "@/lib/crawler/manager";
import { AuthConfigurationError, assertAuthApiToken, encryptAuthProfiles, validateAuthProfiles } from "@/lib/crawler/auth";

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
    let body: { url?: unknown; options?: unknown; confirmPermission?: unknown; authProfiles?: unknown };
    try {
      body = await req.json();
    } catch {
      throw new ApiError(400, "Invalid JSON body");
    }
    if (body.confirmPermission !== true) {
      throw new ApiError(400, "You must confirm that you own the website or have permission to archive it.");
    }
    if (body.authProfiles !== undefined) {
      assertAuthApiToken(req);
      const profiles = validateAuthProfiles(body.authProfiles);
      // Fail closed before creating any jobs when the encryption key is absent or invalid.
      encryptAuthProfiles(profiles);
      await getManager().assertBatchCapacity(profiles.length);
      getManager().reserveAuthBatchStart(clientIp(req));
      const ids: string[] = [];
      for (const profile of profiles) ids.push(await getManager().start(body.url, body.options, clientIp(req), profile));
      return Response.json({ id: ids[0], ids, mode: "separate" }, { status: 201 });
    }
    const id = await getManager().start(body.url, body.options, clientIp(req));
    return Response.json({ id, ids: [id] }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthConfigurationError) return Response.json({ error: e.message }, { status: e.status });
    return handleError(e);
  }
}
