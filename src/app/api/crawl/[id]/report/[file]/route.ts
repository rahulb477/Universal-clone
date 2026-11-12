import fs from "node:fs";
import path from "node:path";
import { handleError } from "@/lib/api";
import { ApiError, jobDir } from "@/lib/crawler/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILES: Record<string, string> = {
  "crawl-report.html": "text/html; charset=utf-8",
  "crawl-report.json": "application/json",
  "failed-urls.txt": "text/plain; charset=utf-8",
  "discovered-urls.txt": "text/plain; charset=utf-8",
  "assets-manifest.json": "application/json",
};

/** Serves a whitelisted report file. Report HTML is sandboxed with a strict CSP. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; file: string }> }) {
  try {
    const { id, file } = await ctx.params;
    const type = FILES[file];
    if (!type) throw new ApiError(404, "Unknown report file");
    const full = path.join(jobDir(id), "report", file);
    const data = await fs.promises.readFile(full).catch(() => null);
    if (!data) throw new ApiError(404, "Report not available");
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": type,
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
