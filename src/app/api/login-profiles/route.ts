import { handleError, json, readJson } from "@/lib/api";
import { authenticatedCrawlingEnabled } from "@/lib/crawler/auth";
import { workerMode } from "@/lib/server/config";
import { createSavedProfile, expireBrowserLogins, listSavedProfiles } from "@/lib/server/login-profiles";
import { workerOnline } from "@/lib/server/jobs";
import { requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/login-profiles?host=example.com
 * The signed-in user's reusable "Login with Browser" profiles (metadata only) plus the deployment
 * capabilities the UI needs to render the workflow honestly.
 */
export async function GET(req: Request) {
  try {
    const { user } = await requireUser(req);
    await expireBrowserLogins().catch(() => {});
    const host = new URL(req.url).searchParams.get("host");
    return json({
      profiles: await listSavedProfiles(user, host),
      features: {
        savedLogins: authenticatedCrawlingEnabled(),
        workerOnline: await workerOnline(),
        workerMode: workerMode(),
      },
    });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * POST /api/login-profiles — create an empty profile, then capture its login with
 * POST /api/login-profiles/:id/browser-login ("Login with Browser" → "Use This Login").
 * Body: { name, startUrl, loginUrl?, authenticatedSelector?, matchSubdomains? }
 */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser(req);
    return json({ profile: await createSavedProfile(user, await readJson(req)) }, { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}
