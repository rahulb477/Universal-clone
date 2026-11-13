import crypto from "node:crypto";

export type AuthenticationMethod = "form" | "manual";

/** Sensitive profile fields are accepted only by the crawl-start boundary. */
export interface AuthProfile {
  id: string;
  name: string;
  loginUrl: string;
  username: string;
  password: string;
  loginButtonSelector?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  authenticatedSelector?: string;
  method: AuthenticationMethod;
  /**
   * CSS selector that identifies a human verification step (MFA / one-time code page). When it is
   * visible after the automated form submission, the login is handed to the user instead of failing.
   * The crawler never answers such a challenge itself.
   */
  mfaSelector?: string;
  /**
   * Additional origins the *interactive* sign-in (manual login / MFA) may navigate and submit to,
   * e.g. a single-sign-on provider. The login page origin is always allowed.
   */
  allowedAuthOrigins?: string[];
}

export interface PublicAuthProfile extends Omit<AuthProfile, "password" | "username"> {
  username: string;
  configured: true;
}

const MAX_PROFILES = Math.min(5, Math.max(1, Number(process.env.CRAWLER_AUTH_MAX_PROFILES) || 5));
const MAX_FIELD = 500;

export class AuthConfigurationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Parse profile input at the API boundary; passwords never enter crawl options or logs. */
export function validateAuthProfiles(input: unknown): AuthProfile[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_PROFILES) {
    throw new AuthConfigurationError(`Configure between 1 and ${MAX_PROFILES} login profiles.`);
  }
  const ids = new Set<string>();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new AuthConfigurationError(`Login profile ${index + 1} is invalid.`);
    const p = raw as Record<string, unknown>;
    const text = (k: string, required = false) => {
      const v = p[k];
      if (typeof v !== "string" || v.length > MAX_FIELD || (required && !v.trim())) {
        if (required) throw new AuthConfigurationError(`Login profile ${index + 1} is missing ${k}.`);
        if (v !== undefined && v !== "") throw new AuthConfigurationError(`Login profile ${index + 1} has an invalid ${k}.`);
        return undefined;
      }
      return v.trim() || undefined;
    };
    const id = text("id", true)!;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new AuthConfigurationError("Login profile IDs must be unique and URL-safe.");
    ids.add(id);
    const name = text("name", true)!;
    const loginUrl = text("loginUrl", true)!;
    let parsed: URL;
    try {
      parsed = new URL(loginUrl);
    } catch {
      throw new AuthConfigurationError(`Login profile ${index + 1} has an invalid login URL.`);
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new AuthConfigurationError("Login URLs must be HTTP(S) and must not contain embedded credentials.");
    // V3.0 clients did not send a method; an omitted method means the automated form login.
    const method = p.method === "manual" ? "manual" : p.method === "form" || p.method == null ? "form" : null;
    if (!method) throw new AuthConfigurationError(`Login profile ${index + 1} has an unsupported authentication method.`);
    const password = text("password", method === "form");
    const username = text("username", method === "form");
    const authenticatedSelector = text("authenticatedSelector");
    if (method === "form" && !authenticatedSelector) throw new AuthConfigurationError(`Login profile ${index + 1} must include an authenticated-state selector.`);
    const profile: AuthProfile = {
      id, name, loginUrl: parsed.href, username: username ?? "", password: password ?? "",
      loginButtonSelector: text("loginButtonSelector"),
      usernameSelector: text("usernameSelector"),
      passwordSelector: text("passwordSelector"),
      authenticatedSelector,
      method,
    };
    const mfaSelector = text("mfaSelector");
    if (mfaSelector) profile.mfaSelector = mfaSelector;
    const origins = parseAllowedOrigins(p.allowedAuthOrigins, index);
    if (origins.length) profile.allowedAuthOrigins = origins;
    return profile;
  });
}

const MAX_AUTH_ORIGINS = 5;

/** Accepts a list (or comma/newline separated string) of http(s) origins; anything else is rejected. */
export function parseAllowedOrigins(input: unknown, index = 0): string[] {
  if (input === undefined || input === null || input === "") return [];
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\s,]+/) : null;
  if (!raw) throw new AuthConfigurationError(`Login profile ${index + 1} has an invalid list of sign-in origins.`);
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) continue;
    let u: URL;
    try {
      u = new URL(item.trim());
    } catch {
      throw new AuthConfigurationError(`Login profile ${index + 1} has an invalid sign-in origin.`);
    }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new AuthConfigurationError("Sign-in origins must be plain HTTP(S) origins.");
    out.add(u.origin);
  }
  if (out.size > MAX_AUTH_ORIGINS) throw new AuthConfigurationError(`At most ${MAX_AUTH_ORIGINS} additional sign-in origins are allowed.`);
  return [...out];
}

function keyBytes(): Buffer {
  const configured = process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY;
  if (!configured) throw new AuthConfigurationError("Authenticated crawling is disabled: set CRAWLER_CREDENTIAL_ENCRYPTION_KEY to a random 32-byte key (hex or base64).", 503);
  const key = /^[a-f\d]{64}$/i.test(configured) ? Buffer.from(configured, "hex") : Buffer.from(configured, "base64");
  if (key.length !== 32) throw new AuthConfigurationError("CRAWLER_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.", 503);
  return key;
}

export function encryptAuthProfiles(profiles: AuthProfile[]): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  cipher.setAAD(Buffer.from("universal-clone-auth-v1"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(profiles), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptAuthProfiles(envelope: string): AuthProfile[] {
  const [version, ivText, tagText, dataText, extra] = envelope.split(".");
  if (version !== "v1" || !ivText || !tagText || !dataText || extra) throw new AuthConfigurationError("Encrypted login data is invalid.");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from("universal-clone-auth-v1"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
    return validateAuthProfiles(JSON.parse(plain));
  } catch {
    throw new AuthConfigurationError("Encrypted login data could not be verified; check the server encryption key.");
  }
}

/** True when the deployment has a usable credential-encryption key (authenticated crawling is opt-in). */
export function authenticatedCrawlingEnabled(): boolean {
  try {
    keyBytes();
    return true;
  } catch {
    return false;
  }
}

/**
 * Generic AES-256-GCM envelope ("v2") for secrets at rest and in the command queue: profile
 * credentials, saved browser sessions, interactive-login input and screenshots.
 *
 * `context` is authenticated as additional data. It binds a ciphertext to its purpose and record
 * (for example `session:<profileId>`), so an envelope copied onto another row fails to decrypt.
 */
export function encryptSecret(plain: string | Buffer, context: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  cipher.setAAD(Buffer.from(`universal-clone-v2|${context}`));
  const data = typeof plain === "string" ? Buffer.from(plain, "utf8") : plain;
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return ["v2", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecretBytes(envelope: string, context: string): Buffer {
  const [version, ivText, tagText, dataText, extra] = envelope.split(".");
  if (version !== "v2" || !ivText || !tagText || dataText === undefined || extra) throw new AuthConfigurationError("Encrypted data is invalid.");
  const key = keyBytes();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(`universal-clone-v2|${context}`));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]);
  } catch {
    throw new AuthConfigurationError("Encrypted data could not be verified; check the server encryption key.");
  }
}

export function decryptSecret(envelope: string, context: string): string {
  return decryptSecretBytes(envelope, context).toString("utf8");
}

/** Masks an account identifier for display ("al***@example.com"); the full value stays encrypted. */
export function usernameHint(username: string): string {
  const u = username.trim();
  if (!u) return "";
  const at = u.indexOf("@");
  const local = at > 0 ? u.slice(0, at) : u;
  const domain = at > 0 ? u.slice(at) : "";
  return `${local.slice(0, Math.min(2, Math.max(1, local.length - 1)))}***${domain}`;
}

export function profileStatus(profile: AuthProfile): PublicAuthProfile {
  const { password: _password, ...safe } = profile;
  return { ...safe, configured: true };
}
