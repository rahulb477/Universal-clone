import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { freePort } from "./server";

export interface TestS3 {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Environment for a process that should use this server as its archive store. */
  env: Record<string, string>;
  /** Keys that are really stored in the bucket right now. */
  objects(): string[];
  /** Requests refused by signature verification, by reason. */
  rejected: Record<string, number>;
  /** Simulated outage: the next `count` uploads are answered with `status`, or the connection is dropped ("drop"). */
  failNextUploads(count: number, how: number | "drop"): void;
  /** Number of PUT requests received so far. */
  uploads(): number;
  close(): Promise<void>;
}

export const S3_ACCESS_KEY = "AKIATESTUNIVERSALCLONE";
export const S3_SECRET_KEY = "test-secret-key-do-not-use-anywhere-else";
const REGION = "us-east-1";

/** AWS's own Signature V4 implementation (the one inside the AWS SDK for JavaScript v3). */
export function awsSigner(accessKeyId = S3_ACCESS_KEY, secretAccessKey = S3_SECRET_KEY, region = REGION) {
  return new SignatureV4({ credentials: { accessKeyId, secretAccessKey }, region, service: "s3", sha256: Sha256, uriEscapePath: false, applyChecksum: false });
}

const amzDate = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

/**
 * An S3-compatible object store for tests.
 *
 * Storage is the third-party `s3rver` package. s3rver itself does not verify Signature V4, so it
 * is only reachable through the gatekeeper below, which behaves like S3's front door: every request
 * must carry a valid V4 signature (Authorization header or pre-signed query), which is recomputed
 * with AWS's `@smithy/signature-v4` and compared; the declared payload hash must match the body;
 * pre-signed URLs expire. Anything else is answered with 403 and never reaches the store.
 */
export async function startS3(bucket = "uc-test-archives"): Promise<TestS3> {
  const S3rver = require("s3rver");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-s3-"));
  const backendPort = await freePort();
  const backend = new S3rver({ port: backendPort, address: "127.0.0.1", silent: true, directory: dir, configureBuckets: [{ name: bucket }] });
  await backend.run();
  const rejected: Record<string, number> = {};
  const signer = awsSigner();

  let outage: { left: number; how: number | "drop" } = { left: 0, how: 503 };
  let uploads = 0;
  const gate = http.createServer((req, res) => {
    if (req.method === "PUT") {
      uploads++;
      if (outage.left > 0) {
        outage.left--;
        if (outage.how === "drop") return void req.socket.destroy();
        req.resume();
        return void res.writeHead(outage.how, { "content-type": "application/xml" }).end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code></Error>`);
      }
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const deny = (code: string, status = 403) => {
          rejected[code] = (rejected[code] ?? 0) + 1;
          res.writeHead(status, { "content-type": "application/xml" }).end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`);
        };
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const [hostname, port] = (req.headers.host ?? "").split(":");
        const base = { method: req.method ?? "GET", protocol: "http:", hostname, port: Number(port), path: url.pathname };
        const auth = req.headers.authorization;
        try {
          if (auth) {
            const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
            if (!m) return deny("AuthorizationHeaderMalformed", 400);
            if (m[1] !== S3_ACCESS_KEY) return deny("InvalidAccessKeyId");
            const declared = String(req.headers["x-amz-content-sha256"] ?? "");
            if (declared !== crypto.createHash("sha256").update(body).digest("hex")) return deny("XAmzContentSHA256Mismatch", 400);
            const when = amzDate(String(req.headers["x-amz-date"] ?? ""));
            if (!(Math.abs(Date.now() - when.getTime()) < 15 * 60 * 1000)) return deny("RequestTimeTooSkewed");
            const headers: Record<string, string> = {};
            for (const h of m[4].split(";")) headers[h] = String(req.headers[h] ?? "");
            const query: Record<string, string> = {};
            url.searchParams.forEach((v, k) => (query[k] = v));
            const expected = await signer.sign({ ...base, query, headers }, { signingDate: when, signableHeaders: new Set(m[4].split(";")) });
            if (expected.headers.authorization !== auth) return deny("SignatureDoesNotMatch");
          } else if (url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256") {
            const q = url.searchParams;
            if (!(q.get("X-Amz-Credential") ?? "").startsWith(S3_ACCESS_KEY + "/")) return deny("InvalidAccessKeyId");
            const when = amzDate(q.get("X-Amz-Date") ?? "");
            const expires = Number(q.get("X-Amz-Expires"));
            if (!(expires > 0) || Date.now() > when.getTime() + expires * 1000) return deny("AccessDenied.Expired");
            const query: Record<string, string> = {};
            q.forEach((v, k) => {
              if (!k.startsWith("X-Amz-")) query[k] = v;
            });
            const expected = await signer.presign(
              { ...base, query, headers: { host: req.headers.host ?? "", "x-amz-content-sha256": "UNSIGNED-PAYLOAD" } },
              { signingDate: when, expiresIn: expires, unsignableHeaders: new Set(["x-amz-content-sha256"]), unhoistableHeaders: new Set(["x-amz-content-sha256"]) },
            );
            if (expected.query?.["X-Amz-Signature"] !== q.get("X-Amz-Signature") || q.get("X-Amz-SignedHeaders") !== "host") return deny("SignatureDoesNotMatch");
          } else {
            return deny("AccessDenied.Anonymous");
          }
        } catch {
          return deny("AccessDenied");
        }
        // Verified: hand over to the store (unsigned, loopback only).
        const fwdHeaders: http.OutgoingHttpHeaders = {};
        for (const h of ["content-type", "content-length", "range"]) if (req.headers[h]) fwdHeaders[h] = req.headers[h];
        // S3 applies response-* overrides only to signed requests; the store behind the gate sees an
        // anonymous one, so the (verified) override is applied here.
        const disposition = url.searchParams.get("response-content-disposition");
        const fwd = http.request({ host: "127.0.0.1", port: backendPort, method: req.method, path: url.pathname, headers: fwdHeaders }, (up) => {
          res.writeHead(up.statusCode ?? 502, { ...up.headers, ...(disposition && up.statusCode === 200 ? { "content-disposition": disposition } : {}) });
          up.pipe(res);
        });
        fwd.on("error", () => res.writeHead(502).end());
        fwd.end(body);
      })();
    });
  });
  const port = await freePort();
  await new Promise<void>((resolve) => gate.listen(port, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
  return {
    endpoint,
    bucket,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    region: REGION,
    env: { ARCHIVE_STORAGE: "s3", S3_ENDPOINT: endpoint, S3_BUCKET: bucket, S3_REGION: REGION, S3_ACCESS_KEY_ID: S3_ACCESS_KEY, S3_SECRET_ACCESS_KEY: S3_SECRET_KEY, S3_FORCE_PATH_STYLE: "1" },
    objects: () =>
      walk(path.join(dir, bucket))
        .filter((f) => f.endsWith("._S3rver_object"))
        .map((f) => path.relative(path.join(dir, bucket), f).replace(/\._S3rver_object$/, "")),
    rejected,
    failNextUploads(count, how) {
      outage = { left: count, how };
    },
    uploads: () => uploads,
    async close() {
      await new Promise((r) => gate.close(r));
      await backend.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
