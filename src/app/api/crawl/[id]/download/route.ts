import { handleError } from "@/lib/api";
import { ApiError } from "@/lib/server/errors";
import { downloadName, ownedJob, recordDownload } from "@/lib/server/jobs";
import { archiveKey, getStore } from "@/lib/server/storage";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The finished ZIP. Access requires the owner's session; there is no public or guessable download
 * URL. With object storage the response is a redirect to a pre-signed URL that expires after
 * DOWNLOAD_URL_TTL_SECONDS (default 60); with local storage the file is streamed.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser(req);
    const row = await ownedJob(user, (await ctx.params).id);
    if (!row.hasZip) throw new ApiError(404, "No archive available for this job");
    const store = getStore();
    const name = downloadName(row);
    const ttl = Math.min(3600, Math.max(10, Number(process.env.DOWNLOAD_URL_TTL_SECONDS) || 60));
    const signed = store.signedUrl(archiveKey(row.id), ttl, name);
    if (signed) {
      await recordDownload(user, row.id);
      return new Response(null, { status: 302, headers: { location: signed, "cache-control": "no-store, private", "referrer-policy": "no-referrer" } });
    }
    const obj = await store.get(archiveKey(row.id));
    if (!obj) throw new ApiError(404, "The archive has expired or was deleted");
    await recordDownload(user, row.id);
    const headers: Record<string, string> = {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    };
    if (obj.size !== undefined) headers["content-length"] = String(obj.size);
    if (row.zipSha256) headers["x-archive-sha256"] = row.zipSha256;
    return new Response(obj.body, { headers });
  } catch (e) {
    return handleError(e);
  }
}
