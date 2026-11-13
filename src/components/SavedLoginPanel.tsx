"use client";

import { useCallback, useEffect, useState } from "react";
import { api, hostMatchesAddress } from "@/lib/client";
import BrowserLoginView, { type BrowserLoginSession } from "./BrowserLoginView";
import LoginProfileForm, { type ProfileDraft } from "./LoginProfileForm";

export type SavedProfile = {
  id: string;
  name: string;
  targetHost: string;
  targetOrigin: string;
  matchSubdomains: boolean;
  startUrl: string;
  loginUrl: string | null;
  authenticatedSelector: string | null;
  usernameHint: string;
  status: "active" | "needs-request-capture" | "session-expired" | "session-rejected" | "login-failed";
  statusLabel: string;
  statusMessage: string | null;
  hasSession: boolean;
  session: { capturedAt: string; expiresAt: string; lastValidatedAt: string | null; cookieCount: number; originCount: number } | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ProfileFeatures = { savedLogins: boolean; workerOnline: boolean; workerMode: string };

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  "needs-request-capture": "bg-amber-500/15 text-amber-200 ring-amber-500/30",
  "session-expired": "bg-orange-500/15 text-orange-200 ring-orange-500/30",
  "session-rejected": "bg-rose-500/15 text-rose-200 ring-rose-500/30",
  "login-failed": "bg-slate-700/40 text-slate-300 ring-slate-600",
};

/** "example.com" for https://app.example.com → shown next to each profile. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

/**
 * Saved "Login with Browser" profiles: create, sign in, rename, re-sign-in, forget, delete — and
 * pick which one a crawl uses. A profile can only be selected for a URL on its own site.
 */
export default function SavedLoginPanel({
  profiles,
  loading,
  url,
  selected,
  onToggle,
  onReload,
  onSaved,
  features,
}: {
  profiles: SavedProfile[];
  loading: boolean;
  url: string;
  selected: string[];
  onToggle: (id: string) => void;
  onReload: () => Promise<void> | void;
  onSaved: (message: string) => void;
  features: ProfileFeatures | null;
}) {
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<SavedProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loginWindow, setLoginWindow] = useState<{ session: BrowserLoginSession; profile: SavedProfile } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  

  async function create(draft: { name: string; address: string }) {
    setBusy(true);
    setError("");
    try {
      const r = await api("/api/login-profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: draft.name, startUrl: draft.address, loginUrl: draft.address }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "The login profile could not be created.");
      setCreating(false);
      await onReload();
      // Go straight into the sign-in flow: that is the whole point of creating one.
      if (features?.workerOnline === false) setError("Profile saved, but no crawl worker is online, so a browser cannot be opened yet.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function rename(draft: { name: string }) {
    if (!renaming) return;
    setBusy(true);
    setError("");
    try {
      const r = await api(`/api/login-profiles/${renaming.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft.name }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "The name could not be saved.");
      setRenaming(null);
      await onReload();
      onSaved("Login profile renamed");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openBrowser(profile: SavedProfile) {
    setError("");
    if (features && features.workerOnline === false) {
      setError("No crawl worker online. Start a worker, then choose “Login with Browser” again.");
      return;
    }
    setBusy(true);
    try {
      const r = await api(`/api/login-profiles/${profile.id}/browser-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryUrl: profile.loginUrl || profile.startUrl }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "The browser could not be opened.");
      setLoginWindow({ session: d.session, profile });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function forget(profile: SavedProfile) {
    if (!globalThis.confirm(`Forget the saved login of “${profile.name}”? The profile stays; you can sign in again at any time.`)) return;
    setBusy(true);
    try {
      const r = await api(`/api/login-profiles/${profile.id}/session`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "The login could not be removed.");
      await onReload();
      onSaved("Saved login removed");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(profile: SavedProfile) {
    setBusy(true);
    setError("");
    try {
      const r = await api(`/api/login-profiles/${profile.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "The profile could not be deleted.");
      setConfirmDelete(null);
      await onReload();
      onSaved("Login profile deleted");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const matches = (p: SavedProfile) => hostMatchesAddress(p.targetHost, p.matchSubdomains, url);

  const btn = "min-h-10 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-50";

  if (!features?.savedLogins) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
        Saved browser logins are disabled: this server has no <code>CRAWLER_CREDENTIAL_ENCRYPTION_KEY</code>. Set it on the web app and the worker to enable the “Login with Browser” workflow.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {features.workerOnline === false && (
        <div role="note" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          No crawl worker online. You can manage profiles, but a browser cannot be opened until a worker connects.
        </div>
      )}

      {loginWindow && (
        <BrowserLoginView
          key={loginWindow.session.id}
          session={loginWindow.session}
          profileName={(profiles.find((p) => p.id === loginWindow.profile.id) ?? loginWindow.profile).name}
          targetHost={loginWindow.profile.targetHost}
          onSaved={(m) => {
            setLoginWindow(null);
            onSaved(m);
            void onReload();
          }}
          onClose={() => setLoginWindow(null)}
          onRetry={(m) => {
            setLoginWindow(null);
            setError(m);
            void onReload();
          }}
        />
      )}

      {creating ? (
        <div className="rounded-xl bg-slate-900/70 p-4 ring-1 ring-slate-700">
          <h4 className="mb-3 text-sm font-semibold text-slate-100">New login profile</h4>
          <LoginProfileForm onSubmit={create} onCancel={() => setCreating(false)} busy={busy} error={error} />
        </div>
      ) : renaming ? (
        <div className="rounded-xl bg-slate-900/70 p-4 ring-1 ring-slate-700">
          <h4 className="mb-3 text-sm font-semibold text-slate-100">Rename “{renaming.name}”</h4>
          <LoginProfileForm initial={{ name: renaming.name, targetHost: renaming.targetHost, startUrl: renaming.startUrl }} onSubmit={rename} onCancel={() => setRenaming(null)} busy={busy} error={error} />
        </div>
      ) : null}

      {error && !creating && !renaming && (
        <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-slate-400">Loading saved logins…</p>
      ) : profiles.length === 0 ? (
        <p className="text-sm text-slate-400">No saved logins yet. A saved login lets a crawl open pages that require signing in.</p>
      ) : (
        <ul className="min-w-0 space-y-2">
          {profiles.map((p) => {
            const usable = matches(p);
            const checked = selected.includes(p.id);
            return (
              <li key={p.id} className={`min-w-0 overflow-hidden rounded-xl bg-slate-900/60 p-3 ring-1 ${checked ? "ring-2 ring-indigo-400" : "ring-slate-700"}`}>
                <div className="flex min-w-0 flex-wrap items-start gap-3">
                  <label className={`flex min-w-0 flex-1 cursor-pointer items-start gap-3 ${usable ? "" : "cursor-not-allowed opacity-60"}`}>
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-400"
                      checked={checked}
                      disabled={!usable}
                      onChange={() => onToggle(p.id)}
                      aria-label={`Use the login profile ${p.name} for this crawl`}
                    />
                    <span className="min-w-0 max-w-full break-words">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <b className="truncate text-sm text-slate-100">{p.name}</b>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${STATUS_STYLE[p.status] ?? STATUS_STYLE["login-failed"]}`}>{p.statusLabel}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-slate-400">
                        {p.targetHost}
                        {p.usernameHint ? ` · ${p.usernameHint}` : ""} · last used {when(p.lastUsedAt)} · {p.useCount} crawl{p.useCount === 1 ? "" : "s"}
                      </span>
                      {p.session && (
                        <span className="block text-[11px] text-slate-500">
                          {p.session.cookieCount} session cookie{p.session.cookieCount === 1 ? "" : "s"} · saved {when(p.session.capturedAt)} · valid until {new Date(p.session.expiresAt).toLocaleDateString()}
                        </span>
                      )}
                      {p.statusMessage && <span className="mt-0.5 block break-words text-[11px] text-amber-300/90">{p.statusMessage}</span>}
                      {!usable && url.trim() && <span className="mt-0.5 block break-words text-[11px] text-slate-500">Not for this address — only for {p.targetHost}.</span>}
                    </span>
                  </label>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={`${btn} !text-emerald-300 !ring-emerald-500/40 hover:!bg-emerald-500/10`} disabled={busy || !!loginWindow} onClick={() => void openBrowser(p)}>
                    {p.hasSession ? "Sign in again" : "Login with Browser"}
                  </button>
                  <button type="button" className={btn} disabled={busy} onClick={() => setRenaming(p)}>
                    Rename
                  </button>
                  {p.hasSession && (
                    <button type="button" className={btn} disabled={busy} onClick={() => void forget(p)}>
                      Forget login
                    </button>
                  )}
                  {confirmDelete === p.id ? (
                    <>
                      <button type="button" className="min-h-10 rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-50" disabled={busy} onClick={() => void remove(p)}>
                        Delete permanently
                      </button>
                      <button type="button" className={btn} onClick={() => setConfirmDelete(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button type="button" className={`${btn} !text-rose-300 !ring-rose-500/30 hover:!bg-rose-500/10`} disabled={busy} onClick={() => setConfirmDelete(p.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!creating && !renaming && (
        <button type="button" onClick={() => setCreating(true)} className="min-h-12 w-full rounded-xl border border-dashed border-slate-600 px-4 py-3 text-sm font-semibold text-slate-200 hover:border-indigo-400 hover:text-white">
          + Save a login for another site
        </button>
      )}
    </div>
  );
}
