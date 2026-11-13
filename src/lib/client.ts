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
