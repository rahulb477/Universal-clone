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
    const method = p.method === "manual" ? "manual" : p.method === "form" ? "form" : null;
    if (!method) throw new AuthConfigurationError(`Login profile ${index + 1} has an unsupported authentication method.`);
    const password = text("password", method === "form");
    const username = text("username", method === "form");
    const authenticatedSelector = text("authenticatedSelector");
    if (method === "form" && !authenticatedSelector) throw new AuthConfigurationError(`Login profile ${index + 1} must include an authenticated-state selector.`);
    return {
      id, name, loginUrl: parsed.href, username: username ?? "", password: password ?? "",
      loginButtonSelector: text("loginButtonSelector"),
      usernameSelector: text("usernameSelector"),
      passwordSelector: text("passwordSelector"),
      authenticatedSelector,
      method,
    };
  });
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

/** Auth-sensitive endpoints require a separately provisioned high-entropy server token. */
export function assertAuthApiToken(request: Request): void {
  const expected = process.env.CRAWLER_AUTH_API_TOKEN;
  if (!expected || expected.length < 32) throw new AuthConfigurationError("Authenticated crawling is disabled: provision CRAWLER_AUTH_API_TOKEN (at least 32 characters).");
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AuthConfigurationError("Authentication access denied.", 401);
}

export function profileStatus(profile: AuthProfile): PublicAuthProfile {
  const { password: _password, ...safe } = profile;
  return { ...safe, configured: true };
}
