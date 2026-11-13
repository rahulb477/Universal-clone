import { sql } from "drizzle-orm";
import { db } from "@/db";
import { handleError, json } from "@/lib/api";
import { requireAdmin } from "@/lib/server/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/overview — administrators only.
 *
 * Proves that the account created by the one-time setup is recognised as an administrator by the
 * existing session architecture: a normal account gets 403, an anonymous visitor 401.
 * It returns account metadata (never password hashes) and a few aggregate counts.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireAdmin(req);
    const users = await db.execute(sql`
      SELECT id, email, role, disabled, created_at
      FROM users
      ORDER BY created_at ASC
      LIMIT 200`);
    const counts = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM users WHERE role = 'admin') AS admins,
        (SELECT count(*)::int FROM crawl_jobs) AS jobs`);
    return json({
      ok: true,
      viewer: { email: ctx.user.email, role: ctx.user.role },
      counts: counts.rows[0] ?? {},
      users: (users.rows as Array<Record<string, unknown>>).map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        disabled: u.disabled,
        createdAt: u.created_at,
      })),
    });
  } catch (e) {
    return handleError(e);
  }
}
