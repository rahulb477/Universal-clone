import { handleError, json } from "@/lib/api";
import { authenticatedCrawlingEnabled } from "@/lib/crawler/auth";
import { workerMode } from "@/lib/server/config";
import { workerOnline } from "@/lib/server/jobs";
import { currentUser, registrationMode } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Session bootstrap for the UI: who is signed in, the CSRF token, and which features this deployment offers. */
export async function GET(req: Request) {
  try {
    const ctx = await currentUser(req);
    // Anonymous visitors get 200 with user: null — the sign-in screen asks this on every load.
    if (!ctx) return json({ user: null, registration: registrationMode() });
    return json({
      user: { email: ctx.user.email, role: ctx.user.role },
      csrfToken: ctx.csrfToken,
      registration: registrationMode(),
      features: { authenticatedCrawling: authenticatedCrawlingEnabled(), workerMode: workerMode(), workerOnline: await workerOnline() },
    });
  } catch (e) {
    return handleError(e);
  }
}
