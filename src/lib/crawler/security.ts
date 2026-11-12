import dns from "node:dns";
import net from "node:net";
import path from "node:path";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

// [network, prefix length]
const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local + cloud metadata (169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true;
  for (const [net_, bits] of BLOCKED_V4) {
    const base = v4ToInt(net_)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((base & mask) >>> 0)) return true;
  }
  return false;
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  // embedded dotted quad
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const n = v4ToInt(tail);
    if (n === null) return null;
    s = s.slice(0, lastColon + 1) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => parseInt(g, 16));
  if (out.some((x) => !Number.isFinite(x) || x < 0 || x > 0xffff)) return null;
  return out;
}

function isBlockedV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isBlockedV4(v4From(g[6], g[7]));
  // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedV4(v4From(g[6], g[7]));
  // 6to4 2002::/16 embeds an IPv4 address
  if (g[0] === 0x2002) return isBlockedV4(v4From(g[1], g[2]));
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** True if the IP literal must never be contacted. Unparseable input is treated as blocked. */
export function isBlockedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, "");
  if (net.isIPv4(clean)) return isBlockedV4(clean);
  if (net.isIPv6(clean)) return isBlockedV6(clean);
  return true;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
  "kubernetes.default.svc",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home.arpa", ".intranet", ".corp"];

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  return BLOCKED_SUFFIXES.some((s) => h.endsWith(s));
}

/** Synchronous checks: scheme, credentials, hostname and IP literals. */
export function checkUrlSyntax(url: URL, allowPrivate = false): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Blocked scheme: ${url.protocol}`);
  }
  if (url.username || url.password) throw new SsrfError("URLs with embedded credentials are not allowed");
  if (!url.hostname) throw new SsrfError("Missing hostname");
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`Blocked private or reserved address: ${host}`);
    return;
  }
  if (isBlockedHostname(host)) throw new SsrfError(`Blocked hostname: ${host}`);
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * A dns.lookup replacement used by the HTTP layer. Checking the resolved address
 * inside the connection's own lookup closes the DNS-rebinding window that a
 * "resolve first, fetch later" approach leaves open.
 */
export function createGuardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate) {
        for (const a of list) {
          if (isBlockedIp(a.address)) {
            return callback(new SsrfError(`Blocked: ${hostname} resolves to private address ${a.address}`) as NodeJS.ErrnoException, "", 4);
          }
        }
      }
      if (options && options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

/** Full check including DNS resolution. Used for browser-initiated requests and the start URL. */
export async function assertPublicUrl(raw: string | URL, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new SsrfError("Invalid URL");
  }
  checkUrlSyntax(url, allowPrivate);
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return url;
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch (e) {
    throw new SsrfError(`DNS lookup failed for ${host}: ${(e as Error).message}`);
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new SsrfError(`Blocked: ${host} resolves to private address ${a.address}`);
  }
  return url;
}

/** Joins a relative path onto root and guarantees the result stays inside root. */
export function safeJoin(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, rel);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path traversal blocked: ${rel}`);
  }
  return full;
}

/** Validates an archive entry name (no absolute paths, no .. segments, no NULs). */
export function isSafeArchiveName(name: string): boolean {
  if (!name || name.includes("\0") || name.includes("\\")) return false;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split("/").some((s) => s === "..");
}
