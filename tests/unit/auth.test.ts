import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AuthConfigurationError, decryptAuthProfiles, encryptAuthProfiles, profileStatus, validateAuthProfiles } from "@/lib/crawler/auth";

afterEach(() => {
  delete process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.CRAWLER_AUTH_API_TOKEN;
});

const profile = (id = "p1") => ({
  id, name: "Test account", loginUrl: "https://example.com/login", username: "user@example.com", password: "correct horse battery staple",
  loginButtonSelector: "button[type=submit]", authenticatedSelector: "[data-authenticated=true]", method: "form",
});

describe("authenticated crawl credential boundary", () => {
  it("encrypts credential records with AES-256-GCM and authenticates the ciphertext", () => {
    process.env.CRAWLER_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    const profiles = validateAuthProfiles([profile()]);
    const envelope = encryptAuthProfiles(profiles);
    expect(envelope).not.toContain(profiles[0].password);
    expect(envelope).not.toContain(profiles[0].username);
    expect(decryptAuthProfiles(envelope)).toEqual(profiles);
    const corrupt = `${envelope.slice(0, -1)}${envelope.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptAuthProfiles(corrupt)).toThrow("could not be verified");
  });

  it("does not expose passwords from the public profile projection", () => {
    const safe = profileStatus(validateAuthProfiles([profile()])[0]);
    expect(safe).not.toHaveProperty("password");
    expect(safe).toHaveProperty("username", "user@example.com");
  });

  it("rejects unsafe login URLs and absent verification selectors", () => {
    expect(() => validateAuthProfiles([{ ...profile(), loginUrl: "javascript:alert(1)" }])).toThrow(AuthConfigurationError);
    const { authenticatedSelector: _removed, ...missing } = profile();
    expect(() => validateAuthProfiles([missing])).toThrow("authenticated-state selector");
  });
});
