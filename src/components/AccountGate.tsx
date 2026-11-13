"use client";

import { useCallback, useEffect, useState } from "react";
import { api, setCsrf } from "@/lib/client";
import Downloader from "./Downloader";

export type Features = { authenticatedCrawling: boolean; savedLogins?: boolean; workerMode: string; workerOnline: boolean };
type Me = { user: { email: string; role: string } | null; registration: "open" | "invite" | "closed"; features?: Features };

/** Shows the sign-in form until a session exists; the downloader is never rendered for anonymous visitors. */
export default function AccountGate() {
  const [me, setMe] = useState<Me | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
      const d = await r.json();
      setCsrf(d.csrfToken ?? "");
      setMe({ user: d.user ?? null, registration: d.registration ?? "closed", features: d.features });
    } catch {
      setMe({ user: null, registration: "closed" });
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0);
    const onOut = () => setMe((m) => (m ? { ...m, user: null } : m));
    window.addEventListener("uc:signed-out", onOut);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("uc:signed-out", onOut);
    };
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (mode === "register") {
        const r = await fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, inviteCode: invite }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Registration failed");
        setNotice("Account created. Sign in to continue.");
        setMode("login");
        return;
      }
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Sign-in failed");
      setPassword("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setCsrf("");
    await load();
  }

  if (!me) return <div className="flex min-h-screen items-center justify-center bg-slate-900 text-slate-300">Loading…</div>;
  if (me.user) return <Downloader userEmail={me.user.email} features={me.features ?? { authenticatedCrawling: false, workerMode: "inline", workerOnline: false }} onSignOut={signOut} />;

  const input = "w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40";
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-900 to-slate-700 px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-slate-900 p-6 shadow-xl">
        <div>
          <h1 className="text-xl font-bold text-slate-50">Universal Clone</h1>
          <p className="mt-1 text-sm text-slate-400">{mode === "login" ? "Sign in to start and manage your downloads." : "Create an account."}</p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400" htmlFor="acc-email">Email</label>
          <input id="acc-email" className={input} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400" htmlFor="acc-password">Password</label>
          <input id="acc-password" className={input} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} />
          {mode === "register" && <p className="mt-1 text-xs text-slate-500">At least 10 characters.</p>}
        </div>
        {mode === "register" && me.registration === "invite" && (
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400" htmlFor="acc-invite">Invite code</label>
            <input id="acc-invite" className={input} type="password" autoComplete="off" required value={invite} onChange={(e) => setInvite(e.target.value)} />
          </div>
        )}
        {error && <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
        {notice && <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
        <button type="submit" disabled={busy} className="w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        {me.registration !== "closed" ? (
          <button type="button" className="w-full text-sm text-indigo-300 hover:underline" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
            {mode === "login" ? "Create an account" : "I already have an account"}
          </button>
        ) : (
          <p className="text-center text-xs text-slate-500">Accounts are created by the operator of this service.</p>
        )}
      </form>
    </div>
  );
}
