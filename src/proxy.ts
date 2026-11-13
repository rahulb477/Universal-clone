import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers for every response, decided at run time (not baked into the build).
 *
 * By default the app refuses to be framed at all. APP_EMBED_ORIGINS (space- or comma-separated
 * origins) names sites that may embed it in an <iframe> — e.g. a hosted preview pane. That weakens
 * click-jacking protection for exactly those origins, so leave it unset in production.
 */
export function embedOrigins(): string[] {
  const raw = (process.env.APP_EMBED_ORIGINS ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  // "*" lets any site frame the app: acceptable for a throw-away demo, never for a real deployment.
  if (raw.includes("*")) return ["*"];
  return raw.filter((s) => /^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(s));
}

export function proxy(req: NextRequest) {
  const res = NextResponse.next();
  const embed = embedOrigins();
  // API routes set their own, stricter policies (archived reports are served sandboxed); headers set
  // here would replace them, so the page policy is only applied to non-API responses.
  if (!req.nextUrl.pathname.startsWith("/api/")) {
    res.headers.set("Content-Security-Policy", `frame-ancestors ${embed.length ? embed.join(" ") : "'none'"}; base-uri 'self'; form-action 'self'; object-src 'none'`);
    if (!embed.length) res.headers.set("X-Frame-Options", "DENY");
  }
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "same-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production" && process.env.AUTH_COOKIE_SECURE !== "0") res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return res;
}

export const config = {
  // Everything except static build assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
