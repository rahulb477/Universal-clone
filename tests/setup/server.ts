import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";

/** Helpers that boot the real production processes (`next start`, `npm run worker`) for end-to-end tests. */

/** The node arguments of `npm run worker` / `db:migrate` / `user:create` (see package.json). */
const NODE_ARGS = ["--import", "./scripts/load-env.mjs", "--import", "tsx"];

export const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Environment without the Chromium variables the test runner sets: a web tier must work without a browser. */
export function envWithoutBrowser(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CHROMIUM_PATH;
  delete env.LD_LIBRARY_PATH;
  return env;
}

export interface Proc {
  proc: ChildProcess;
  output(): string;
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

function track(proc: ChildProcess): Proc {
  let out = "";
  proc.stdout?.on("data", (d) => (out += d));
  proc.stderr?.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  return {
    proc,
    output: () => out,
    async stop(signal: NodeJS.Signals = "SIGTERM") {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      return exited;
    },
  };
}

export interface Web extends Proc {
  base: string;
  port: number;
}

/** `next start` on a free port. Requires a prior `npm run build`. */
export async function bootWeb(env: Record<string, string>, baseEnv: NodeJS.ProcessEnv = process.env): Promise<Web> {
  const port = await freePort();
  const p = track(
    spawn(process.execPath, [path.join(process.cwd(), "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
      env: { ...baseEnv, AUTH_COOKIE_SECURE: "0", CRAWLER_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY, ...env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (p.proc.exitCode !== null) break;
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) return { ...p, base, port };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  await p.stop("SIGKILL");
  throw new Error(`next start did not become healthy (run \`npm run build\` first):\n${p.output()}`);
}

/** The persistent worker entry point, exactly as `npm run worker` starts it. */
export async function bootWorker(env: Record<string, string>): Promise<Proc> {
  const p = track(
    // Same command as `npm run worker`: one process, so signals reach the worker itself.
    spawn(process.execPath, [...NODE_ARGS, "src/worker/main.ts"], {
      env: { ...process.env, CRAWLER_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  for (let i = 0; i < 240; i++) {
    if (/\] started \(/.test(p.output())) return p;
    if (p.proc.exitCode !== null) throw new Error(`worker exited early:\n${p.output()}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await p.stop("SIGKILL");
  throw new Error(`worker did not start:\n${p.output()}`);
}

/** Runs one of the tsx command-line tools (migrations, user creation) and returns its result. */
export function runCli(script: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [...NODE_ARGS, script, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

export interface Client {
  email: string;
  cookie: string;
  csrf: string;
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  del(path: string): Promise<Response>;
  json<T = any>(path: string): Promise<T>;
}

/** Signs in over HTTP and returns a client that sends the session cookie and the CSRF token, like the UI does. */
export async function signIn(base: string, email: string, password: string): Promise<Client> {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error(`sign-in failed for ${email}: ${r.status} ${await r.text()}`);
  const setCookie = r.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  const csrf = (await r.json()).csrfToken as string;
  const client: Client = {
    email,
    cookie,
    csrf,
    get: (p, init) => fetch(base + p, { ...init, headers: { cookie, ...(init?.headers as Record<string, string> | undefined) }, redirect: "manual" }),
    post: (p, body, headers) => fetch(base + p, { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
    del: (p) => fetch(base + p, { method: "DELETE", headers: { cookie, "x-csrf-token": csrf } }),
    json: async (p) => (await client.get(p)).json(),
  };
  return client;
}

export interface SseEvent {
  type: string;
  id?: number;
  data: any;
}

/** Reads the Server-Sent Events stream until `until` returns true (or the stream ends). */
export async function readSse(url: string, cookie: string, until: (e: SseEvent, all: SseEvent[]) => boolean, timeoutMs = 90000, headers: Record<string, string> = {}): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const res = await fetch(url, { headers: { cookie, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) throw new Error(`not an event stream: ${res.status} ${await res.text()}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      const id = /^id: (.*)$/m.exec(block)?.[1];
      if (type && data) {
        const ev = { type, data: JSON.parse(data), id: id ? Number(id) : undefined };
        events.push(ev);
        if (until(ev, events)) {
          await reader.cancel();
          return events;
        }
      }
    }
  }
  return events;
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60000, everyMs = 300): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
