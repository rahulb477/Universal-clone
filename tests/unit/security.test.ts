import http from "node:http";
import { describe, expect, it } from "vitest";
import { assertPublicUrl, checkUrlSyntax, isBlockedIp, isSafeArchiveName, safeJoin, SsrfError } from "@/lib/crawler/security";
import { HttpError, httpGet } from "@/lib/crawler/http";
import { startFixture } from "../fixtures/site";

describe("SSRF protection", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows public address %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it.each([
    "http://localhost/",
    "http://LOCALHOST:8080/",
    "http://foo.localhost/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/", // decimal form of 127.0.0.1
    "http://0x7f.0.0.1/", // hex form
    "http://127.1/", // short form
    "http://0177.0.0.1/", // octal form
    "http://10.1.2.3:3000/",
    "http://printer.local/",
    "http://db.internal/",
    "file:///etc/passwd",
    "ftp://example.com/",
    "http://user:pass@example.com/",
    "gopher://example.com/",
  ])("rejects %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(SsrfError);
  });

  it("accepts public IP literals and skips checks only when explicitly allowed", async () => {
    await expect(assertPublicUrl("http://8.8.8.8/")).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://127.0.0.1/", true)).resolves.toBeInstanceOf(URL);
    expect(() => checkUrlSyntax(new URL("http://127.0.0.1/"), false)).toThrow(SsrfError);
  });

  it("the HTTP layer refuses private targets before connecting", async () => {
    const fx = await startFixture();
    try {
      await expect(httpGet(fx.url + "/", { allowPrivate: false })).rejects.toMatchObject({ kind: "blocked" });
      expect(fx.hits.size).toBe(0); // the server never saw a request
    } finally {
      await fx.close();
    }
  });

  it("validates every redirect hop", async () => {
    const fx = await startFixture("http://169.254.169.254");
    try {
      // First hop is allowed (private network enabled for the test), but the redirect target is validated.
      await expect(
        httpGet(fx.url + "/redirect-external", {
          allowPrivate: true,
          validateRedirect: (u) => checkUrlSyntax(u, false),
        }),
      ).rejects.toMatchObject({ kind: "blocked" });
    } finally {
      await fx.close();
    }
  });

  it("detects redirect loops", async () => {
    const fx = await startFixture();
    try {
      await expect(httpGet(fx.url + "/redirect-loop", { allowPrivate: true })).rejects.toMatchObject({ kind: "redirect_loop" });
    } finally {
      await fx.close();
    }
  });

  it("enforces the response size limit while streaming", async () => {
    const server = http.createServer((_, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(Buffer.alloc(300 * 1024));
      res.end(Buffer.alloc(300 * 1024));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const err = await httpGet(`http://127.0.0.1:${port}/`, { allowPrivate: true, maxBytes: 100 * 1024 }).catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.kind).toBe("too_large");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("path safety", () => {
  it("safeJoin refuses traversal", () => {
    expect(() => safeJoin("/tmp/site", "../etc/passwd")).toThrow();
    expect(() => safeJoin("/tmp/site", "a/../../b")).toThrow();
    expect(safeJoin("/tmp/site", "a/b.html")).toBe("/tmp/site/a/b.html");
  });
  it("archive names are validated", () => {
    expect(isSafeArchiveName("a/b/c.html")).toBe(true);
    expect(isSafeArchiveName("../evil")).toBe(false);
    expect(isSafeArchiveName("a/../../evil")).toBe(false);
    expect(isSafeArchiveName("/abs")).toBe(false);
    expect(isSafeArchiveName("C:/abs")).toBe(false);
    expect(isSafeArchiveName("a\\b")).toBe(false);
  });
});
