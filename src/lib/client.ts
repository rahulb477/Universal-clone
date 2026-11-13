"use client";

let csrf = "";

export function setCsrf(token: string) {
  csrf = token;
}

/**
 * fetch() for the app's own API: same-origin cookies only, and the session's CSRF token on every
 * state-changing request. A 401 tells the shell that the session ended.
 */
export async function api(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD" && csrf) headers.set("x-csrf-token", csrf);
  const res = await fetch(input, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (res.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("uc:signed-out"));
  return res;
}

/**
 * Does a saved login belong to this address? Mirrors the server's rule: the exact host (with its
 * port) always matches, a subdomain only when the profile allows it, and an IP literals never
 * matches "any subdomain". Kept in the client bundle so the panel and the API agree.
 */
export function hostMatchesAddress(targetHost: string, matchSubdomains: boolean, address: string): boolean {
  let host: string;
  try {
    const u = new URL(address);
    const port = u.port && !((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) ? `:${u.port}` : "";
    host = `${u.hostname.toLowerCase()}${port}`;
  } catch {
    return false;
  }
  const target = targetHost.toLowerCase();
  if (host === target) return true;
  if (!matchSubdomains) return false;
  const targetName = target.split(":")[0];
  const candidateName = host.split(":")[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(targetName) || targetName.includes(":")) return false;
  return candidateName.endsWith(`.${targetName}`) && candidateName.length > targetName.length + 1;
}
