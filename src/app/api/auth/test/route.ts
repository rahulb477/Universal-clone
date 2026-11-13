import { handleError, json, readJson } from "@/lib/api";
import { AuthConfigurationError, authenticatedCrawlingEnabled, validateAuthProfiles } from "@/lib/crawler/auth";
import { allowPrivateNetworks, workerMode } from "@/lib/server/config";
import { ApiError } from "@/lib/server/errors";
import { rateLimit, requireUser } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { profile } — tries an automated form login once and reports whether the authenticated-state
 * selector appeared. Needs a browser, so it only exists where the web process hosts the worker
 * ("inline" mode); in the web/worker split, start a crawl instead — login is verified before crawling.
 */
export async function POST(req: Request) {
  let profile: ReturnType<typeof validateAuthProfiles>[number] | undefined;
  try {
    const ctx = await requireUser(req);
    if (workerMode() !== "inline") throw new ApiError(501, "Login tests are not available on this deployment; the login is verified when the crawl starts.");
    if (!authenticatedCrawlingEnabled()) throw new AuthConfigurationError("Authenticated crawling is disabled: set CRAWLER_CREDENTIAL_ENCRYPTION_KEY to a random 32-byte key (hex or base64).", 503);
    await rateLimit(`auth-test:${ctx.user.id}`, 10, 600, "Too many login tests. Try again later.");
    const body = await readJson(req, 16384);
    const raw = body.profile && typeof body.profile === "object" ? { ...(body.profile as object), id: "test" } : body.profile;
    profile = validateAuthProfiles([raw])[0];
    if (profile.method !== "form") throw new ApiError(400, "Only automated form logins can be tested; a manual login is verified interactively when the crawl starts.");
    const { Renderer } = await import("@/lib/crawler/renderer");
    const { assertPublicUrl } = await import("@/lib/crawler/security");
    await assertPublicUrl(profile.loginUrl, allowPrivateNetworks()).catch(() => {
      throw new ApiError(400, "This login URL is not allowed.");
    });
    const renderer = await Renderer.create(allowPrivateNetworks());
    if (!renderer) throw new AuthConfigurationError(`Chromium unavailable: ${Renderer.lastError}`, 503);
    try {
      const outcome = await renderer.authenticate(profile, 30000, { interactiveTimeoutMs: 5000 });
      if (outcome.status === "interactive") {
        await outcome.login.cancel("Login test finished.");
        return json({ ok: true, status: "awaiting-manual-verification", message: "The credentials were accepted and the site asked for an additional verification step. You will complete it yourself when the crawl starts." });
      }
      return json({ ok: true, status: "authenticated" });
    } catch {
      throw new ApiError(400, "Login failed or authenticated-state verification timed out. Check the profile and server browser configuration.");
    } finally {
      await renderer.clearAuthContext();
      await renderer.close();
    }
  } catch (error) {
    return handleError(error);
  } finally {
    if (profile) {
      profile.password = "";
      profile.username = "";
    }
  }
}
