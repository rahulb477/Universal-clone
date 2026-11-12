import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export async function startAuthSite() {
  const sessions = new Map<string, { user: string; valid: boolean }>();
  let expireNextOrders = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    if (url.pathname === "/login" && req.method === "GET") {
      return send(200, '<!doctype html><title>Sign in</title><form method="post" action="/login"><input name="username" type="email"><input name="password" type="password"><button id="login" type="submit">Sign in</button></form>');
    }
    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const values = new URLSearchParams(body);
      const username = values.get("username") || "";
      if (values.get("password") !== "pw-" + username) return send(401, "invalid credentials");
      const token = crypto.randomBytes(10).toString("hex");
      sessions.set(token, { user: username, valid: true });
      return send(302, "", { location: "/dashboard", "set-cookie": `sid=${token}; HttpOnly; Path=/; SameSite=Lax` });
    }
    const token = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const session = token ? sessions.get(token) : undefined;
    if (!session?.valid) return send(302, "", { location: "/login" });
    if (url.pathname === "/dashboard") return send(200, `<!doctype html><title>Dashboard</title><header class="account" data-authenticated="true">Account ${session.user}</header><a href="/account/orders">Orders</a>`);
    if (url.pathname === "/account/orders") {
      if (expireNextOrders) {
        expireNextOrders = false;
        session.valid = false;
        return send(302, "", { location: "/login" });
      }
      return send(200, `<!doctype html><title>Orders</title><p>Private orders for ${session.user}</p><a href="/account/settings">Settings</a>`);
    }
    if (url.pathname === "/account/settings") return send(200, `<!doctype html><title>Settings</title><p>Settings for ${session.user}</p>`);
    if (url.pathname === "/robots.txt") return send(404, "not found", { "content-type": "text/plain" });
    return send(404, "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    expireNextSessionOnOrders() { expireNextOrders = true; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
