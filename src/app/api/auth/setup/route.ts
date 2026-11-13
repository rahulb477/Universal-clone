import { handleError, json, readJson } from "@/lib/api";
import { ApiError } from "@/lib/server/errors";
import { createFirstAdmin, publicSetupStatus } from "@/lib/server/setup";
import { assertSameOrigin } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/setup — { setupAvailable, state, message }
 *
 * `setupAvailable` is true only when ADMIN_SETUP_KEY is configured and usable and no administrator
 * (and no completed-setup marker) exists. The key itself is never read out here.
 */
export async function GET() {
  try {
    return json(await publicSetupStatus());
  } catch (e) {
    return handleError(e);
  }
}

/**
 * POST /api/auth/setup — { setupKey, email, password, confirmPassword }
 *
 * Creates the *first* administrator, once. Cross-origin requests and non-JSON content types are
 * rejected, the key is compared in constant time, the password is hashed with the app's scrypt
 * scheme, and the insert runs in one transaction behind a PostgreSQL advisory lock.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    // A JSON content type cannot be produced by a plain HTML form, so this also blocks
    // form-based cross-site posts that carry no Origin header.
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) throw new ApiError(415, "Expected an application/json request body.");
    const body = await readJson(req, 8192);
    const result = await createFirstAdmin(req, {
      email: body.email,
      password: body.password,
      confirmPassword: body.confirmPassword,
      setupKey: body.setupKey,
    });
    // The account is not signed in automatically: the operator is sent to the normal sign-in page.
    return json({ ok: true, user: { email: result.user.email, role: result.user.role }, next: "/" }, { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}
