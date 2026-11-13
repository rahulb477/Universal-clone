import { describe, expect, it } from "vitest";
import { databaseErrorCode, databaseFingerprint } from "@/db/diagnostics";

describe("database diagnostics", () => {
  it("fingerprints only host and database name, ignoring credentials and options", () => {
    const a = databaseFingerprint("postgres://alice:secret@EXAMPLE.com/mydb?sslmode=require");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(databaseFingerprint("postgresql://bob:other@example.com/mydb?sslmode=disable")).toBe(a);
    expect(databaseFingerprint("postgres://alice:secret@example.com/other")).not.toBe(a);
    expect(databaseFingerprint("postgres://alice:secret@other.example.com/mydb")).not.toBe(a);
    expect(databaseFingerprint("bad secret value")).toBeNull();
  });
  it("never returns an error message", () => {
    expect(databaseErrorCode({ cause: { code: "42P01", message: "password" } })).toBe("42P01");
    expect(databaseErrorCode({ code: "secret", message: "postgres://secret" })).toBe("unknown");
  });
});
