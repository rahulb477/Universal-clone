import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export interface AuthSiteStats {
  loginPosts: number;
  mfaPosts: number;
  trackPosts: number;
  logoutHits: number;
  deleteHits: number;
  graphqlQueries: number;
  graphqlMutations: number;
  /** path -> who requested it ("anon" or the signed-in user) */
  hits: Record<string, string[]>;
}

/**
 * Controlled authenticated site.
 *
 * Default: the small V3.0 fixture (login → dashboard → orders → settings).
 * `rich: true` adds protected images / CSS / fonts, XHR + paginated JSON, GraphQL, a state-changing
 * tracker, per-user pages, an admin area, logout / delete links, an MFA step and a public asset.
 *
 * Accounts: any username with password `pw-<username>`.
 *   mfa-*    → password is followed by a one-time-code page (code 123456)
 *   admin-*  → may open /admin/reports
 */
export async function startAuthSite(opts: { rich?: boolean } = {}) {
  const rich = !!opts.rich;
  const sessions = new Map<string, { user: string; valid: boolean }>();
  const pending = new Map<string, string>();
  let expireNextOrders = false;
  const stats: AuthSiteStats = { loginPosts: 0, mfaPosts: 0, trackPosts: 0, logoutHits: 0, deleteHits: 0, graphqlQueries: 0, graphqlMutations: 0, hits: {} };
  const hit = (path: string, who: string) => {
    (stats.hits[path] ??= []).push(who);
  };
  const readBody = async (req: http.IncomingMessage) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    return body;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (status: number, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => send(status, JSON.stringify(data), { "content-type": "application/json", ...headers });
    const newSession = (username: string) => {
      const token = crypto.randomBytes(10).toString("hex");
      sessions.set(token, { user: username, valid: true });
      return send(302, "", { location: "/dashboard", "set-cookie": `sid=${token}; HttpOnly; Path=/; SameSite=Lax` });
    };
    if (url.pathname === "/robots.txt") return send(404, "not found", { "content-type": "text/plain" });
    if (url.pathname === "/login" && req.method === "GET") {
      return send(200, '<!doctype html><title>Sign in</title><form method="post" action="/login"><input name="username" type="email"><input name="password" type="password"><button id="login" type="submit">Sign in</button></form>');
    }
    if (url.pathname === "/login" && req.method === "POST") {
      stats.loginPosts++;
      const values = new URLSearchParams(await readBody(req));
      const username = values.get("username") || "";
      if (values.get("password") !== "pw-" + username) return send(401, "invalid credentials");
      if (rich && username.startsWith("mfa-")) {
        const p = crypto.randomBytes(8).toString("hex");
        pending.set(p, username);
        return send(302, "", { location: "/mfa", "set-cookie": `pending=${p}; HttpOnly; Path=/; SameSite=Lax` });
      }
      return newSession(username);
    }
    if (rich && url.pathname === "/mfa") {
      const p = /(?:^|;\s*)pending=([^;]+)/.exec(req.headers.cookie || "")?.[1];
      const username = p ? pending.get(p) : undefined;
      if (!username) return send(302, "", { location: "/login" });
      const form = (msg = "") => `<!doctype html><title>Verification</title><form id="otp-form" method="post" action="/mfa"><p>Enter the 6-digit code from your authenticator app. ${msg}</p><input name="code" inputmode="numeric" autofocus><button type="submit">Verify</button></form>`;
      if (req.method === "GET") return send(200, form());
      stats.mfaPosts++;
      const values = new URLSearchParams(await readBody(req));
      if (values.get("code") !== "123456") return send(401, form("Wrong code."));
      pending.delete(p!);
      return newSession(username);
    }
    if (rich && url.pathname === "/public/logo.png") {
      hit(url.pathname, "request");
      return send(200, PNG, { "content-type": "image/png" });
    }
    const token = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const session = token ? sessions.get(token) : undefined;
    const isAsset = /^\/(private|api|graphql)/.test(url.pathname);
    if (!session?.valid) {
      if (rich && isAsset) {
        hit(url.pathname, "anon");
        return send(403, "forbidden", { "content-type": "text/plain" });
      }
      return send(302, "", { location: "/login" });
    }
    const user = session.user;
    if (!rich) {
      if (url.pathname === "/dashboard") return send(200, `<!doctype html><title>Dashboard</title><header class="account" data-authenticated="true">Account ${user}</header><a href="/account/orders">Orders</a>`);
    } else {
      if (isAsset) hit(url.pathname, user);
      if (url.pathname === "/dashboard") {
        return send(
          200,
          `<!doctype html><html><head><title>Dashboard</title><link rel="stylesheet" href="/private/app.css"></head><body>
<header class="account" data-authenticated="true">Account ${user}</header>
<img id="logo" src="/public/logo.png" alt="logo">
<img id="avatar" src="/private/avatar.svg" alt="avatar">
<img id="hero" src="/private/hero-1x.png" srcset="/private/hero-1x.png 1x, /private/hero-2x.png 2x" alt="hero">
<picture><source srcset="/private/wide.png" media="(min-width: 600px)"><img src="/private/narrow.png" alt="pic"></picture>
<img id="lazy" data-src="/private/lazy.png" loading="lazy" alt="lazy">
<div id="inline-bg" style="background-image:url('/private/inline-bg.png')">bg</div>
<svg width="10" height="10"><image href="/private/sprite.svg" width="10" height="10"/><use href="/private/icons.svg#star"/></svg>
<nav>
<a href="/account/orders">Orders</a>
<a href="/users/${encodeURIComponent(user)}/notes">My notes</a>
${user.startsWith("admin-") ? '<a href="/admin/reports">Admin reports</a>' : ""}
<a href="/logout">Sign out</a>
<a href="/account/delete?confirm=1">Delete account</a>
</nav>
<div id="out"></div>
<script>
document.getElementById('lazy').src = document.getElementById('lazy').dataset.src;
fetch('/api/me').then(r => r.json()).then(d => { document.getElementById('out').textContent = d.displayName; });
var x = new XMLHttpRequest(); x.open('GET', '/api/orders?page=1'); x.send();
fetch('/api/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'view' }) }).catch(function () {});
fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query Viewer { viewer { name } }' }) }).catch(function () {});
fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'mutation Rename { rename(name: "x") { ok } }' }) }).catch(function () {});
</script></body></html>`,
        );
      }
      if (url.pathname === "/private/app.css") return send(200, `@font-face{font-family:Priv;src:url(/private/font.woff2) format("woff2")}\nbody{font-family:Priv,sans-serif;background-image:url("/private/bg.png")}\n.account{color:#123456}`, { "content-type": "text/css" });
      if (url.pathname === "/private/font.woff2") return send(200, Buffer.from("wOF2-fixture-font-bytes"), { "content-type": "font/woff2" });
      if (url.pathname === "/private/avatar.svg") return send(200, `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><text y="20">avatar-of-${user}</text></svg>`, { "content-type": "image/svg+xml" });
      if (url.pathname === "/private/icons.svg") return send(200, `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="star" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></symbol></svg>`, { "content-type": "image/svg+xml" });
      if (url.pathname === "/private/sprite.svg") return send(200, `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`, { "content-type": "image/svg+xml" });
      // Trailing bytes make every image distinct, so content de-duplication cannot hide a missing download.
      if (/^\/private\/[a-z0-9-]+\.png$/.test(url.pathname)) return send(200, Buffer.concat([PNG, Buffer.from(url.pathname)]), { "content-type": "image/png" });
      if (url.pathname === "/api/me") return json(200, { displayName: `User ${user}`, email: user, accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ", cardNumber: "4111 1111 1111 1111", avatarUrl: "/private/api-avatar.png" });
      if (url.pathname === "/api/orders") {
        const page = Number(url.searchParams.get("page") || 1);
        return json(200, { items: [{ id: page * 10 + 1, owner: user }, { id: page * 10 + 2, owner: user }], page, next: page < 3 ? `/api/orders?page=${page + 1}` : null });
      }
      if (url.pathname === "/api/track") {
        if (req.method === "POST") stats.trackPosts++;
        return json(200, { ok: true });
      }
      if (url.pathname === "/graphql" && req.method === "POST") {
        const body = await readBody(req);
        if (/mutation/.test(body)) {
          stats.graphqlMutations++;
          return json(200, { data: { rename: { ok: true } } });
        }
        stats.graphqlQueries++;
        return json(200, { data: { viewer: { name: user } } });
      }
      if (url.pathname === "/logout") {
        stats.logoutHits++;
        session.valid = false;
        return send(302, "", { location: "/login" });
      }
      if (url.pathname === "/account/delete") {
        stats.deleteHits++;
        return send(200, "<!doctype html><title>Deleted</title><p>account deleted</p>");
      }
      const notes = /^\/users\/([^/]+)\/notes$/.exec(url.pathname);
      if (notes) {
        if (decodeURIComponent(notes[1]) !== user) return send(403, "<!doctype html><title>Forbidden</title><p>not your notes</p>");
        return send(200, `<!doctype html><title>Notes</title><p>Secret notes of ${user}</p><img src="/private/avatar.svg" alt="avatar">`);
      }
      if (url.pathname === "/admin/reports") {
        if (!user.startsWith("admin-")) return send(403, "<!doctype html><title>Forbidden</title><p>admins only</p>");
        return send(200, `<!doctype html><title>Reports</title><p>Admin report for ${user}</p><a href="/account/settings">Settings</a>`);
      }
    }
    if (url.pathname === "/account/orders") {
      if (expireNextOrders) {
        expireNextOrders = false;
        session.valid = false;
        return send(302, "", { location: "/login" });
      }
      return send(200, `<!doctype html><title>Orders</title><p>Private orders for ${user}</p><a href="/account/settings">Settings</a>`);
    }
    if (url.pathname === "/account/settings") return send(200, `<!doctype html><title>Settings</title><p>Settings for ${user}</p>`);
    return send(404, "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    expireNextSessionOnOrders() { expireNextOrders = true; },
    /** Invalidates every session (server-side logout of all users). */
    expireAllSessions() { for (const s of sessions.values()) s.valid = false; },
    activeSessions: () => [...sessions.values()].filter((s) => s.valid).map((s) => s.user),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
