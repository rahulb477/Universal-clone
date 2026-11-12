import { AuthConfigurationError, assertAuthApiToken, encryptAuthProfiles, validateAuthProfiles } from "@/lib/crawler/auth";
import { Renderer } from "@/lib/crawler/renderer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let profile: ReturnType<typeof validateAuthProfiles>[number] | undefined;
  let renderer: Renderer | null = null;
  try {
    assertAuthApiToken(req);
    const body = await req.json().catch(() => ({}));
    const profiles = validateAuthProfiles([body.profile]);
    profile = profiles[0];
    encryptAuthProfiles(profiles); // validates encryption-key availability before touching credentials
    renderer = await Renderer.create(process.env.CRAWLER_ALLOW_PRIVATE_NETWORKS === "1");
    if (!renderer) throw new AuthConfigurationError(`Chromium unavailable: ${Renderer.lastError}`);
    await renderer.authenticate(profile, 30000);
    return Response.json({ ok: true, status: "authenticated" });
  } catch (error) {
    if (error instanceof AuthConfigurationError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Login failed or authenticated-state verification timed out. Check the profile and server browser configuration." }, { status: 400 });
  } finally {
    if (profile) {
      profile.password = "";
      profile.username = "";
    }
    await renderer?.clearAuthContext();
    await renderer?.close();
  }
}
