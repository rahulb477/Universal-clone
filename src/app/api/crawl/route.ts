import { handleError, json, readJson } from "@/lib/api";
import { createCrawl, listJobs } from "@/lib/server/jobs";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/crawl — the signed-in user's download history. */
export async function GET(req: Request) {
  try {
    const { user } = await requireUser(req);
    return json({ jobs: await listJobs(user) });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * POST /api/crawl — queue a crawl.
 * Body: { url, options?, confirmPermission: true, authProfiles?, authMode?: "separate" | "combined" }
 * The owner is always the signed-in user; profile ids are generated server-side.
 */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser(req);
    const result = await createCrawl(user, await readJson(req));
    return json(result, { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}
