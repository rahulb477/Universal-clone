import { afterAll, describe, expect, it } from "vitest";
import { checkStrongPassword, describeState, setupKeyInfo, setupKeyMatches } from "@/lib/server/setup";

/**
 * Unit tests for the policy layer of the one-time setup: secret handling, the password policy and
 * the public status vocabulary. They need no database — everything here is pure.
 */

const KEY = "Zk3jJ8vQ2mXpR7tLbN4wY6cH1sD9fG0aE5uI2oP8qW";
const saved = { ...process.env };

afterAll(() => {
  process.env = saved;
});

describe("ADMIN_SETUP_KEY handling", () => {
  it("is not configured when the variable is missing or blank", () => {
    delete process.env.ADMIN_SETUP_KEY;
    expect(setupKeyInfo()).toEqual({ key: null, state: "not-configured" });
    expect(setupKeyMatches(KEY)).toBe(false);
    process.env.ADMIN_SETUP_KEY = "   ";
    expect(setupKeyInfo()).toEqual({ key: null, state: "not-configured" });
  });

  it("refuses keys shorter than 32 characters", () => {
    process.env.ADMIN_SETUP_KEY = KEY.slice(0, 31);
    expect(setupKeyInfo()).toEqual({ key: null, state: "key-too-weak" });
    // 31 characters is rejected, 32 accepted.
    process.env.ADMIN_SETUP_KEY = KEY.slice(0, 32);
    expect(setupKeyInfo().state).toBe("configured");
  });

  it("refuses low-entropy and placeholder keys even when they are long", () => {
    for (const weak of ["a".repeat(64), "ab".repeat(24), "changeme-".repeat(6), "please-change-me-in-vercel-settings-now"]) {
      process.env.ADMIN_SETUP_KEY = weak;
      expect(setupKeyInfo(), weak).toEqual({ key: null, state: "key-too-weak" });
    }
  });

  it("accepts a generated secret and matches it in constant time", () => {
    process.env.ADMIN_SETUP_KEY = KEY;
    expect(setupKeyInfo()).toEqual({ key: KEY, state: "configured" });
    expect(setupKeyMatches(KEY)).toBe(true);
    expect(setupKeyMatches(`${KEY}x`)).toBe(false);
    expect(setupKeyMatches(KEY.slice(0, -1))).toBe(false);
    expect(setupKeyMatches("")).toBe(false);
    expect(setupKeyMatches(undefined)).toBe(false);
    expect(setupKeyMatches(12345)).toBe(false);
    expect(setupKeyMatches("Z".repeat(1000))).toBe(false);
  });

  it("never matches when no key is configured", () => {
    delete process.env.ADMIN_SETUP_KEY;
    expect(setupKeyMatches("")).toBe(false);
    expect(setupKeyMatches("anything")).toBe(false);
  });
});

describe("administrator password policy", () => {
  const good = "Tr0ub4dor&3-horse";
  it("accepts a strong password", () => {
    expect(checkStrongPassword(good)).toEqual({ ok: true, problems: [] });
  });

  it("rejects short, one-class and email-derived passwords", () => {
    expect(checkStrongPassword("Short1!").ok).toBe(false);
    expect(checkStrongPassword("aaaaaaaaaaaaaaa").ok).toBe(false);
    expect(checkStrongPassword("aaaaaaaaaaaaaaa").problems.join(" ")).toMatch(/three of/);
    expect(checkStrongPassword("lowercaseonly123").ok).toBe(false);
    expect(checkStrongPassword("12345678901234").ok).toBe(false);
    expect(checkStrongPassword("Rahul4319-my-password", "rahul4319@example.com").problems.join(" ")).toMatch(/email/);
    expect(checkStrongPassword("x".repeat(201) + "Aa1!").ok).toBe(false);
    expect(checkStrongPassword(undefined).ok).toBe(false);
    expect(checkStrongPassword("").ok).toBe(false);
  });
});

describe("public setup status", () => {
  it("speaks about availability without revealing the key", () => {
    for (const state of ["available", "completed", "not-configured", "key-too-weak"] as const) {
      const s = describeState(state);
      expect(s.setupAvailable).toBe(state === "available");
      expect(s.message.length).toBeGreaterThan(10);
      expect(s.message).not.toContain(KEY);
      expect(s.message).not.toContain("ADMIN_SETUP_KEY=");
    }
  });
});
