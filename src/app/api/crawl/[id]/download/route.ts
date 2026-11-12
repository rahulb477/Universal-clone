import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { handleError } from "@/lib/api";
import { ApiError, getManager, jobDir } from "@/lib/crawler/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams the finished ZIP archive. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const row = await getManager().getRow(id);
    if (!row || !row.hasZip) throw new ApiError(404, "No archive available for this job");
    const file = path.join(jobDir(id), "site.zip");
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) throw new ApiError(404, "The archive has expired or was deleted");
    let host = "site";
    try {
      host = new URL(row.url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    } catch {
      /* keep default */
    }
    const body = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream;
    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(stat.size),
        "content-disposition": `attachment; filename="${host}-${id.slice(0, 8)}.zip"`,
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
