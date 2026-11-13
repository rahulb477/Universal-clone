import { AuthConfigurationError } from "@/lib/crawler/auth";
import { ApiError } from "@/lib/server/errors";

const NO_STORE = { "cache-control": "no-store" };

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(data, { status: init.status ?? 200, headers: { ...NO_STORE, ...init.headers } });
}

export function handleError(e: unknown): Response {
  if (e instanceof ApiError) return Response.json({ error: e.message }, { status: e.status, headers: { ...NO_STORE, ...e.headers } });
  if (e instanceof AuthConfigurationError) return Response.json({ error: e.message }, { status: e.status, headers: NO_STORE });
  console.error("[api]", e instanceof Error ? e.message : e);
  return Response.json({ error: "Internal server error" }, { status: 500, headers: NO_STORE });
}

export async function readJson(req: Request, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new ApiError(413, "Request body is too large.");
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new ApiError(400, "Invalid request body");
  }
  if (text.length > maxBytes) throw new ApiError(413, "Request body is too large.");
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
}
