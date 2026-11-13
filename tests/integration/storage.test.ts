import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { archiveKey, getStore, reportKey, resetStore, S3Store, sha256File, type ArchiveStore } from "@/lib/server/storage";
import { awsSigner, startS3, type TestS3 } from "../setup/s3";

/**
 * Archive storage: the local directory store and the S3 store. The S3 client signs requests itself
 * (AWS Signature V4, no SDK), so it is checked two ways: its signatures are compared with the ones
 * AWS's own library produces, and it runs against an S3-compatible server whose front door
 * recomputes every signature with that library (tests/setup/s3.ts).
 */

let s3: TestS3;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uc-store-"));
const saved = { ...process.env };

beforeAll(async () => {
  s3 = await startS3();
});
afterAll(async () => {
  await s3?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = saved;
  resetStore();
});

function sample(name: string, size: number) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, crypto.randomBytes(size));
  return file;
}
const readAll = async (s: ArchiveStore, key: string) => {
  const o = await s.get(key);
  return o ? Buffer.from(await new Response(o.body).arrayBuffer()) : null;
};

function contract(name: string, make: () => ArchiveStore) {
  describe(`${name} store`, () => {
    it("stores, streams back byte-identical, and deletes archives and reports", async () => {
      const store = make();
      await store.check();
      const id = crypto.randomBytes(8).toString("hex");
      const zip = sample(`${name}.zip`, 300_000);
      const original = fs.readFileSync(zip);
      const sha = await sha256File(zip);
      await store.putFile(archiveKey(id), zip, "application/zip", { sha256: sha });
      const report = sample(`${name}.json`, 2000);
      await store.putFile(reportKey(id, "crawl-report.json"), report, "application/json");

      const back = await readAll(store, archiveKey(id));
      expect(back!.equals(original)).toBe(true);
      expect(crypto.createHash("sha256").update(back!).digest("hex")).toBe(sha);
      expect((await store.get(archiveKey(id)))!.size).toBe(original.length);
      expect((await readAll(store, reportKey(id, "crawl-report.json")))!.equals(fs.readFileSync(report))).toBe(true);
      expect(await store.get(archiveKey("0000000000000000"))).toBeNull();

      await store.remove([archiveKey(id), reportKey(id, "crawl-report.json")]);
      expect(await store.get(archiveKey(id))).toBeNull();
      expect(await store.get(reportKey(id, "crawl-report.json"))).toBeNull();
      // Removing something that is already gone is not an error (retention may race with a manual delete).
      await store.remove([archiveKey(id)]);
    });

    it("`move` uploads consume the source file", async () => {
      const store = make();
      const id = crypto.randomBytes(8).toString("hex");
      const zip = sample(`${name}-move.zip`, 5000);
      await store.putFile(archiveKey(id), zip, "application/zip", { move: true });
      expect(fs.existsSync(zip)).toBe(false);
      expect((await readAll(store, archiveKey(id)))!.length).toBe(5000);
      await store.remove([archiveKey(id)]);
    });

    it("refuses keys that could escape the store", async () => {
      const store = make();
      const f = sample(`${name}-evil.bin`, 10);
      const started = Date.now();
      for (const key of ["../outside.zip", "jobs/../../etc/passwd", "/abs/path", "jobs/a b/site.zip", "jobs/x/..", ""]) {
        await expect(store.putFile(key, f, "application/zip"), key).rejects.toThrow("invalid storage key");
        await expect(store.get(key), key).rejects.toThrow("invalid storage key");
      }
      // Refused before anything is sent or retried.
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });
}

contract("local", () => {
  process.env.ARCHIVE_STORAGE = "local";
  process.env.ARCHIVE_DIR = path.join(tmp, "local-root");
  resetStore();
  return getStore();
});

contract("S3", () => {
  Object.assign(process.env, s3.env);
  resetStore();
  return getStore();
});

describe("local store on disk", () => {
  it("writes under the configured root only and has no public URLs", async () => {
    process.env.ARCHIVE_STORAGE = "local";
    process.env.ARCHIVE_DIR = path.join(tmp, "local-root");
    resetStore();
    const store = getStore();
    expect(store.kind).toBe("local");
    const id = "abcdef0123456789";
    await store.putFile(archiveKey(id), sample("disk.zip", 100), "application/zip");
    expect(fs.existsSync(path.join(tmp, "local-root", "jobs", id, "site.zip"))).toBe(true);
    expect(store.signedUrl(archiveKey(id), 60)).toBeNull();
    await store.remove([archiveKey(id)]);
    expect(fs.existsSync(path.join(tmp, "local-root", "jobs", id))).toBe(false);
  });
});

describe("S3 store: Signature V4 matches AWS's implementation", () => {
  const cfg = { endpoint: "https://s3.eu-central-1.amazonaws.com", region: "eu-central-1", bucket: "my-archives", accessKeyId: "AKIAEXAMPLEKEY", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const at = new Date("2026-03-04T05:06:07Z");

  for (const pathStyle of [true, false]) {
    it(`pre-signed URL (${pathStyle ? "path-style" : "virtual-hosted"}) is identical to the AWS signer's`, async () => {
      vi.useFakeTimers({ now: at, toFake: ["Date"] });
      try {
        const url = new URL(new S3Store({ ...cfg, pathStyle }).signedUrl("jobs/0123456789abcdef/site.zip", 60, "example.com-01234567.zip"));
        const hostname = pathStyle ? "s3.eu-central-1.amazonaws.com" : "my-archives.s3.eu-central-1.amazonaws.com";
        const objectPath = pathStyle ? "/my-archives/jobs/0123456789abcdef/site.zip" : "/jobs/0123456789abcdef/site.zip";
        expect(url.hostname).toBe(hostname);
        expect(url.pathname).toBe(objectPath);
        const expected = await awsSigner(cfg.accessKeyId, cfg.secretAccessKey, cfg.region).presign(
          { method: "GET", protocol: "https:", hostname, path: objectPath, query: { "response-content-disposition": 'attachment; filename="example.com-01234567.zip"' }, headers: { host: hostname, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" } },
          { signingDate: at, expiresIn: 60, unsignableHeaders: new Set(["x-amz-content-sha256"]), unhoistableHeaders: new Set(["x-amz-content-sha256"]) },
        );
        expect(url.searchParams.get("X-Amz-Signature")).toBe(expected.query!["X-Amz-Signature"]);
        expect(url.searchParams.get("X-Amz-Credential")).toBe(expected.query!["X-Amz-Credential"]);
        expect(url.searchParams.get("X-Amz-Date")).toBe("20260304T050607Z");
        expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

describe("S3 store: signatures and pre-signed downloads", () => {
  const make = (over: Partial<ConstructorParameters<typeof S3Store>[0]> = {}) => new S3Store({ endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, pathStyle: true, ...over });

  it("is selected by configuration and really writes to the bucket", async () => {
    Object.assign(process.env, s3.env);
    resetStore();
    const store = getStore();
    expect(store.kind).toBe("s3");
    const id = "1111222233334444";
    await store.putFile(archiveKey(id), sample("bucket.zip", 4096), "application/zip");
    expect(s3.objects()).toContain(`jobs/${id}/site.zip`);
    await store.remove([archiveKey(id)]);
    expect(s3.objects()).not.toContain(`jobs/${id}/site.zip`);
  });

  it("a pre-signed URL downloads the archive without credentials, with a download file name", async () => {
    const store = make();
    const id = "5555666677778888";
    const zip = sample("signed.zip", 50_000);
    const sha = await sha256File(zip);
    await store.putFile(archiveKey(id), zip, "application/zip");
    const url = store.signedUrl(archiveKey(id), 60, "example.com-55556666.zip");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).not.toContain(s3.secretAccessKey + "/"); // the secret itself is never in the URL
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="example.com-55556666.zip"');
    expect(crypto.createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex")).toBe(sha);

    // The object is not public: no signature, a tampered signature, or another object's signature are refused.
    expect((await fetch(url.replace("example.com-55556666.zip", "other-name.zip"))).status).toBe(403);
    expect((await fetch(`${s3.endpoint}/${s3.bucket}/${archiveKey(id)}`)).status).toBe(403);
    expect((await fetch(url.replace(/X-Amz-Signature=[0-9a-f]{8}/, "X-Amz-Signature=00000000"))).status).toBe(403);
    expect((await fetch(url.replace(id, "9999000011112222"))).status).toBe(403);
    await store.remove([archiveKey(id)]);
  });

  it("a pre-signed URL stops working after its lifetime", async () => {
    const store = make();
    const id = "aaaabbbbccccdddd";
    await store.putFile(archiveKey(id), sample("expiring.zip", 100), "application/zip");
    const url = store.signedUrl(archiveKey(id), 1);
    expect((await fetch(url)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await fetch(url)).status).toBe(403);
    await store.remove([archiveKey(id)]);
  });

  it("wrong credentials fail the start-up check instead of failing later at upload time", async () => {
    const before = { ...s3.rejected };
    await expect(make({ secretAccessKey: "not-the-secret" }).check()).rejects.toThrow(/HTTP 403/);
    expect(s3.rejected.SignatureDoesNotMatch).toBe((before.SignatureDoesNotMatch ?? 0) + 1);
    await expect(make({ accessKeyId: "UNKNOWNKEY" }).check()).rejects.toThrow(/HTTP 403/);
    await expect(make({ region: "eu-west-1" }).check()).rejects.toThrow(/HTTP 403/);
    await expect(make({ bucket: "no-such-bucket" }).check()).rejects.toThrow(/HTTP 404/);
    await make().check();
  });

  it("an upload survives a short outage of the bucket: 503, 429 and dropped connections are retried", async () => {
    const store = make({ retryDelayMs: 20 });
    for (const how of [503, 429, "drop"] as const) {
      const file = sample(`flaky-${how}.zip`, 70000);
      const key = `jobs/5555666677778888/flaky-${how}.zip`;
      const before = s3.uploads();
      s3.failNextUploads(2, how);
      await store.putFile(key, file, "application/zip", { move: true });
      expect(s3.uploads() - before, String(how)).toBe(3);
      expect(fs.existsSync(file)).toBe(false);
      const stored = await readAll(store, key);
      expect(stored?.length).toBe(70000);
      await store.remove([key]);
    }
  });

  it("gives up after three attempts, keeps the source file, and does not retry errors that cannot go away", async () => {
    const store = make({ retryDelayMs: 20 });
    const file = sample("outage.zip", 5000);
    let before = s3.uploads();
    s3.failNextUploads(3, 503);
    await expect(store.putFile("jobs/5555666677778888/outage.zip", file, "application/zip", { move: true })).rejects.toThrow(/upload failed: HTTP 503/);
    expect(s3.uploads() - before).toBe(3);
    expect(fs.existsSync(file)).toBe(true);
    expect(s3.objects()).not.toContain("jobs/5555666677778888/outage.zip");

    before = s3.uploads();
    await expect(make({ retryDelayMs: 20, secretAccessKey: "not-the-secret" }).putFile("jobs/5555666677778888/outage.zip", file, "application/zip")).rejects.toThrow(/HTTP 403/);
    expect(s3.uploads() - before).toBe(1);
    // An unreachable endpoint is a connection error: retried, then reported as such.
    await expect(make({ retryDelayMs: 20, endpoint: "http://127.0.0.1:9" }).putFile("jobs/5555666677778888/outage.zip", file, "application/zip")).rejects.toThrow(/object storage upload failed: /);
  });
});
