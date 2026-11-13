import { createHash } from "node:crypto";

/** Identifies the configured endpoint, not the physical server behind a proxy or DNS alias. */
export function databaseFingerprint(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) return null;
    const name = decodeURIComponent(parsed.pathname.slice(1));
    return createHash("sha256").update(JSON.stringify([parsed.hostname.toLowerCase(), name])).digest("hex");
  } catch {
    return null;
  }
}

/** Only an allowlisted error code is logged; pg/Drizzle messages may contain SQL or secrets. */
export function databaseErrorCode(error: unknown): string {
  let e = error;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const item = e as { code?: unknown; cause?: unknown };
    if (typeof item.code === "string" && /^(?:[0-9A-Z]{5}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)$/.test(item.code)) return item.code;
    e = item.cause;
  }
  return "unknown";
}
