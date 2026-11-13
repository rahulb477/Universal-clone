import crypto from "node:crypto";
import { encryptSecret, decryptSecret, AuthConfigurationError } from "./auth";
import type { SessionState } from "./interactive-login";

/**
 * Reusable "Login with Browser" profiles.
 *
 * This module is pure (no database, no browser): validation of the untrusted shape, the target-host
 * scope rules, the encrypted-session envelope and the redaction of session material. The account
 * bound storage lives in `@/lib/server/login-profiles`; the browser side lives in
 * `src/worker/browser-login.ts`.
 *
 * Scope rule: a profile is pinned to one host (plus its subdomains only when the user asks for it).
 * A session captured for `example.com` can never be attached to a crawl of `other.example` — the
 * attachment point re-checks it and the envelope's additional authenticated data includes the host,
 * so a row moved to another profile fails to decrypt.
 */

/** How long a worker keeps an unused "Login with Browser" browser open after the user stops. */
export const LOGIN_BROWSER_IDLE_GRACE_MS = 90_000;

export type SavedProfileStatus = "active" | "needs-request-capture" | "session-expired" | "session-rejected" | "login-failed";

export const SAVED_PROFILE_STATUS_TEXT: Record<SavedProfileStatus, string> = {
  active: "Login saved",
  "needs-request-capture": "Sign-in needs a request login",
  "session-expired": "Session expired — sign in again",
  "session-rejected": "Login no longer valid",
  "login-failed": "Sign-in failed",
};

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const MAX_NAME = 80;
const MAX_SELECTOR = 400;

export class SavedProfileError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Normalises a user-typed address to a URL ("example.com" → "https://example.com/"). */
export function normalizeAddress(raw: unknown, field = "URL"): URL {
  if (typeof raw !== "string" || !raw.trim()) throw new SavedProfileError(`Enter a ${field}.`);
  let text = raw.trim();
  if (text.length > 2048) throw new SavedProfileError(`The ${field} is too long.`);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = "https://" + text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SavedProfileError(`That is not a valid ${field}.`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new SavedProfileError(`The ${field} must start with http:// or https://.`);
  if (url.username || url.password) throw new SavedProfileError(`The ${field} must not contain a username or password.`);
  if (!url.hostname) throw new SavedProfileError(`That is not a valid ${field}.`);
  url.hash = "";
  return url;
}

/** Host a profile is pinned to: hostname plus the port when it is not the scheme default. */
export function hostKey(url: URL): string {
  const port = url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) ? `:${url.port}` : "";
  return `${url.hostname.toLowerCase()}${port}`;
}

export function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").split(":")[0];
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":") || /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,}$/i.test(bare);
}

export interface ProfileScope {
  targetHost: string;
  targetOrigin: string;
  matchSubdomains: boolean;
}

/**
 * True when a URL belongs to the profile's target site. Never a substring test: `evil-example.com`
 * and `example.com.attacker.net` do not match `example.com`.
 */
export function hostMatchesScope(scope: Pick<ProfileScope, "targetHost" | "matchSubdomains">, urlOrHost: string): boolean {
  let host = urlOrHost;
  try {
    const u = new URL(urlOrHost);
    host = hostKey(u);
  } catch {
    /* already a host key */
  }
  const target = scope.targetHost.toLowerCase();
  const candidate = host.toLowerCase();
  if (candidate === target) return true;
  if (!scope.matchSubdomains) return false;
  const targetName = target.split(":")[0];
  const candidateName = candidate.split(":")[0];
  if (isIpLiteral(targetName)) return false; // no subdomains of an IP address
  return candidateName.endsWith(`.${targetName}`) && candidateName.length > targetName.length + 1;
}

export interface CreateProfileInput {
  name: string;
  startUrl: string;
  loginUrl?: string | null;
  authenticatedSelector?: string | null;
  matchSubdomains?: boolean;
}

/** Validates the untrusted body of POST/PATCH /api/login-profiles. */
export function validateProfileInput(raw: unknown, partial = false): Partial<CreateProfileInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SavedProfileError("Invalid profile.");
  const p = raw as Record<string, unknown>;
  const out: Partial<CreateProfileInput> = {};
  const text = (k: string, max: number) => {
    const v = p[k];
    if (v === undefined) return undefined;
    if (v === null || v === "") return "";
    if (typeof v !== "string") throw new SavedProfileError(`Invalid ${k}.`);
    const t = v.trim();
    if (t.length > max) throw new SavedProfileError(`The ${k} is too long (max ${max} characters).`);
    return t;
  };

  const name = text("name", MAX_NAME);
  if (name !== undefined) {
    if (!name) throw new SavedProfileError("Give the login profile a name.");
    out.name = name;
  } else if (!partial) throw new SavedProfileError("Give the login profile a name.");

  if (p.startUrl !== undefined) {
    out.startUrl = normalizeAddress(p.startUrl, "website address").href;
  } else if (!partial) {
    throw new SavedProfileError("Enter the website address this login belongs to.");
  }

  if (p.loginUrl !== undefined) {
    out.loginUrl = p.loginUrl === "" || p.loginUrl === null ? null : normalizeAddress(p.loginUrl, "sign-in page address").href;
  }
  if (p.authenticatedSelector !== undefined) {
    const sel = text("authenticatedSelector", MAX_SELECTOR);
    out.authenticatedSelector = sel ? sel : null;
  }
  if (p.matchSubdomains !== undefined) {
    if (typeof p.matchSubdomains !== "boolean") throw new SavedProfileError("matchSubdomains must be true or false.");
    out.matchSubdomains = p.matchSubdomains;
  }
  return out;
}

/** Ensures the optional sign-in page belongs to the same site as the target address. */
export function assertLoginUrlInScope(startUrl: string, loginUrl: string | null | undefined, matchSubdomains: boolean): void {
  if (!loginUrl) return;
  const start = new URL(startUrl);
  const scope = { targetHost: hostKey(start), matchSubdomains };
  if (!hostMatchesScope(scope, loginUrl)) throw new SavedProfileError(`The sign-in page must be on ${scope.targetHost} (or enable “also match subdomains”).`);
}

// ---------- session envelope ----------

/** Additional authenticated data of one stored session: binds ciphertext to profile, owner and host. */
export function sessionAad(profileId: string, ownerId: string, targetHost: string): string {
  return `saved-session:${profileId}:${ownerId}:${targetHost.toLowerCase()}`;
}

export interface StoredSession {
  envelope: string;
  cookieCount: number;
  originCount: number;
}

/** Serialises + encrypts a captured browser session. The plaintext never reaches the database. */
export function sealSession(profileId: string, ownerId: string, targetHost: string, state: SessionState): StoredSession {
  const json = JSON.stringify(state);
  const cookies = Array.isArray(state?.cookies) ? state.cookies.length : 0;
  const origins = Array.isArray(state?.origins) ? state.origins.length : 0;
  return { envelope: encryptSecret(json, sessionAad(profileId, ownerId, targetHost)), cookieCount: cookies, originCount: origins };
}

/** Decrypts a stored session. Throws when the envelope was copied to another profile/owner/host. */
export function openSession(profileId: string, ownerId: string, targetHost: string, envelope: string): SessionState {
  const json = decryptSecret(envelope, sessionAad(profileId, ownerId, targetHost));
  try {
    return JSON.parse(json) as SessionState;
  } catch {
    throw new AuthConfigurationError("The saved login session is corrupt.");
  }
}

/**
 * Trims a captured storage state to the profile's site before it is stored: cookies for unrelated
 * domains (analytics, identity providers, advertising) and localStorage of other origins are dropped.
 * This is what stops one site's cookies from ever being replayed at another site, even if a later
 * code path forgot to check the scope.
 */
export function scopeSessionState(scope: ProfileScope, state: SessionState): SessionState {
  const target = scope.targetHost.toLowerCase().split(":")[0];
  const cookies = (state.cookies ?? []).filter((c) => {
    const domain = c.domain.replace(/^\./, "").toLowerCase();
    if (!domain) return false;
    // The target host's own cookies.
    if (domain === target) return true;
    // A cookie set on a parent domain (".example.com") is sent by the browser to app.example.com too.
    if (target.endsWith(`.${domain}`)) return true;
    // Sub-domains of the target, only when the profile allows them.
    if (scope.matchSubdomains && domain.endsWith(`.${target}`)) return true;
    return false;
  });
  const origins = (state.origins ?? []).filter((o) => {
    try {
      return hostMatchesScope(scope, o.origin);
    } catch {
      return false;
    }
  });
  return { cookies, origins };
}

/** Non-reversible fingerprint of a session, for change detection in tests and diagnostics. */
export function sessionFingerprint(state: SessionState): string {
  return crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 16);
}

// ---------- request-login (-d) fallback ----------

export type RequestCaptureFormat = "wget-commands" | "curl-commands" | "headers";

export interface ImportedRequestSession {
  state: SessionState;
  cookieCount: number;
  hosts: string[];
  /** Redacted list of the headers that were imported (never their values). */
  headerNames: string[];
}

const COOKIE_HEADER_RE = /(^|\s)(--header|-H)\s*=?\s*(['"]?)cookie\s*:\s*([^'"\n]+)/gi;
const SET_COOKIE_LINE_RE = /^\s*cookie\s*:\s*(.+)$/gim;
const RAW_COOKIE_LINE_RE = /^\s*([A-Za-z0-9_!#$%&'*+.^`|~-]+)\s*=\s*([^;\s]+)/;

/**
 * Parses a command line captured from the browser's DevTools ("Copy as cURL" / "Copy as wget") or a
 * pasted `Cookie:` header, and turns it into the same storage state the browser capture produces.
 *
 * Sites whose sign-in does not survive a headless browser (device checks, request signing) are the
 * reason this exists. It never bypasses anything: the user performs the sign-in themselves and hands
 * over a request that already carries their own session.
 */
export function parseRequestCapture(raw: unknown, scope: ProfileScope): ImportedRequestSession {
  if (typeof raw !== "string" || !raw.trim()) throw new SavedProfileError("Paste the request line from your browser's developer tools.");
  if (raw.length > 64 * 1024) throw new SavedProfileError("That capture is too large (max 64 KB). Paste only the request commands.");
  const text = raw.replace(/\\\r?\n/g, " ");

  const cookies = new Map<string, { value: string; domain: string; secure: boolean }>();
  const addPair = (pair: string, secure: boolean) => {
    for (const part of pair.split(";")) {
      const m = RAW_COOKIE_LINE_RE.exec(part.trim());
      if (!m) continue;
      const [, name, value] = m;
      if (/(pass|token|secret|auth|bearer|csrf|xsrf)/i.test(name) && !value) continue;
      cookies.set(`${name}=${value}`, { value, domain: scope.targetHost.split(":")[0], secure });
    }
  };
  for (const m of text.matchAll(COOKIE_HEADER_RE)) addPair(m[4], true);
  for (const m of text.matchAll(SET_COOKIE_LINE_RE)) addPair(m[1], true);
  // A bare cookie pair list with no `Cookie:` label.
  if (cookies.size === 0 && /[A-Za-z0-9_-]+=/.test(text) && !/^(-H|--header|wget|curl)/m.test(text.trim())) {
    if (text.trim().length <= 8192) addPair(text.trim(), true);
  }

  const headerNames = new Set<string>();
  for (const m of text.matchAll(/(?:--header|-H)\s*=?\s*['"]?([A-Za-z-]{2,40})\s*:/gi)) headerNames.add(m[1].trim().toLowerCase());
  for (const m of text.matchAll(/(?:^|\s)([A-Za-z-]{2,40})\s*:\s*\S/gm)) headerNames.add(m[1].toLowerCase());
  headerNames.delete("cookie");
  for (const banned of ["authorization", "proxy-authorization"]) headerNames.delete(banned);

  if (cookies.size === 0) throw new SavedProfileError("No cookies were found in that capture. Use “Copy as cURL” of a signed-in request.");

  const host = scope.targetHost.split(":")[0];
  const state: SessionState = {
    cookies: [...cookies.entries()].map(([key, c]) => ({
      name: key.slice(0, key.indexOf("=")),
      value: c.value,
      domain: c.domain,
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: c.secure,
      sameSite: "Lax" as const,
    })),
    origins: [],
  };
  return { state, cookieCount: state.cookies.length, hosts: [host], headerNames: [...headerNames].sort() };
}
