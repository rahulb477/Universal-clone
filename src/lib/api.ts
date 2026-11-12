import { ApiError } from "@/lib/crawler/manager";

export function handleError(e: unknown): Response {
  if (e instanceof ApiError) return Response.json({ error: e.message }, { status: e.status });
  console.error("[api]", e);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : req.headers.get("x-real-ip")) || "local";
}
