"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthenticationStatus } from "@/lib/crawler/types";
import { api } from "@/lib/client";
import type { Features } from "./AccountGate";
import LoginPanel, { type LoginSessionInfo } from "./LoginPanel";

type Stats = {
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesRemaining: number;
  pagesFailed: number;
  pagesSkipped: number;
  assetsDiscovered: number;
  assetsDownloaded: number;
  assetsFailed: number;
  duplicateUrls: number;
  duplicateAssets: number;
  externalLinks: number;
  currentUrls: string[];
  bytesDownloaded: number;
  speedBps: number;
  maxDepthReached: number;
  progress: number;
  elapsedMs: number;
  status: string;
  stopReason?: string;
  apiEndpoints?: number;
  profiles?: { profileId: string; name?: string; status: AuthenticationStatus; pagesDiscovered: number; pagesDownloaded: number }[];
};
type Log = { t: number; tag: string; message: string };
type LoginProfile = {
  id: string;
  name: string;
  loginUrl: string;
  username: string;
  password: string;
  loginButtonSelector: string;
  usernameSelector: string;
  passwordSelector: string;
  authenticatedSelector: string;
  mfaSelector: string;
  allowedAuthOrigins: string;
  method: "form" | "manual";
  editing: boolean;
  status: AuthenticationStatus;
  jobId?: string;
};
type Job = {
  id: string;
  url: string;
  status: string;
  stats: Stats | null;
  error: string | null;
  stopReason: string | null;
  hasZip: boolean;
  zipBytes: number;
  createdAt: string;
  finishedAt: string | null;
  mode?: string;
  zipSha256?: string | null;
  downloadCount?: number;
};
type JobProfile = { id: string; name: string; method: string; usernameHint: string; status: AuthenticationStatus; credentialsStored: boolean; sessionStored: boolean };

const DEFAULTS = {
  maxDepth: 5,
  maxPages: 200,
  maxFileSizeMb: 25,
  maxTotalSizeMb: 500,
  delayMs: 100,
  concurrency: 4,
  renderMode: "fast",
  includeSubdomains: false,
  crawlQueryParams: true,
  useSitemap: true,
  downloadAssets: true,
  externalAssets: true,
  respectRobots: true,
  visualCompare: false,
  apiDiscovery: "metadata",
  apiFollowPagination: false,
  graphqlEndpoints: "",
  includePatterns: "",
  excludePatterns: "",
  stripParams: "utm_source, utm_medium, utm_campaign, utm_term, utm_content, fbclid, gclid, msclkid, mc_cid, mc_eid",
  denyParams: "sessionid, phpsessid, sid, replytocom, print, share",
  allowParams: "",
  maxQueryVariantsPerPath: 30,
  retries: 3,
};

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const list = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

const TAG_COLOR: Record<string, string> = {
  FOUND: "text-sky-400",
  CRAWLING: "text-amber-300",
  ASSET: "text-violet-300",
  COMPLETE: "text-emerald-400",
  FAILED: "text-rose-400",
  SKIP: "text-slate-400",
  RETRY: "text-orange-300",
  WARN: "text-yellow-300",
  DUP: "text-slate-400",
  INFO: "text-slate-200",
};

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-indigo-100 text-indigo-800",
  running: "bg-sky-100 text-sky-800",
  paused: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-slate-200 text-slate-700",
  failed: "bg-rose-100 text-rose-800",
  interrupted: "bg-orange-100 text-orange-800",
};

export default function Downloader({ userEmail, features, onSignOut }: { userEmail: string; features: Features; onSignOut: () => void }) {
  const [url, setUrl] = useState("");
  const [streamKey, setStreamKey] = useState(0);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authMode, setAuthMode] = useState<"separate" | "combined">("separate");
  const [jobProfiles, setJobProfiles] = useState<JobProfile[]>([]);
  const [loginSessions, setLoginSessions] = useState<LoginSessionInfo[]>([]);
  const [profiles, setProfiles] = useState<LoginProfile[]>([]);
  const [testingProfile, setTestingProfile] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [showAdv, setShowAdv] = useState(false);
  const [s, setS] = useState(DEFAULTS);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [history, setHistory] = useState<Job[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const loadHistory = useCallback(async () => {
    try {
      const r = await api("/api/crawl");
      if (r.ok) setHistory((await r.json()).jobs);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadHistory(), 0);
    const t = window.setInterval(loadHistory, 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(t); };
  }, [loadHistory]);

  // Live updates via Server-Sent Events
  useEffect(() => {
    if (!activeId) return;
    const reset = window.setTimeout(() => { setLogs([]); setStats(null); setJobProfiles([]); setLoginSessions([]); }, 0);
    // Same-origin EventSource sends the session cookie; the route checks that the job belongs to this user.
    const es = new EventSource(`/api/crawl/${activeId}/events`);
    es.addEventListener("snapshot", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setJob(d.job);
      setStats(d.job.stats);
      setLogs(d.logs);
      setJobProfiles(d.profiles ?? []);
      setLoginSessions(d.loginSessions ?? []);
    });
    es.addEventListener("login", (e) => {
      setLoginSessions(JSON.parse((e as MessageEvent).data).sessions ?? []);
    });
    es.addEventListener("stats", (e) => {
      const st = JSON.parse((e as MessageEvent).data) as Stats;
      setStats(st);
      setJob((j) => (j ? { ...j, status: st.status } : j));
    });
    es.addEventListener("log", (e) => {
      const l = JSON.parse((e as MessageEvent).data) as Log;
      setLogs((prev) => (prev.length > 600 ? [...prev.slice(-400), l] : [...prev, l]));
    });
    es.addEventListener("status", (e) => {
      const status = JSON.parse((e as MessageEvent).data);
      setJob((j) => (j ? { ...j, status } : j));
    });
    es.addEventListener("job", (e) => {
      setJob(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener("done", async () => {
      es.close();
      const r = await api(`/api/crawl/${activeId}`);
      if (r.ok) {
        const d = await r.json();
        setJob(d.job);
        setStats(d.job.stats);
        setJobProfiles(d.profiles ?? []);
        setLoginSessions(d.loginSessions ?? []);
      }
      void loadHistory();
    });
    es.onerror = () => {
      /* the browser reconnects automatically; snapshot resyncs state */
    };
    return () => { window.clearTimeout(reset); es.close(); };
    // streamKey: the stream ends when a crawl is interrupted; resuming it opens a new one.
  }, [activeId, streamKey, loadHistory]);

  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const upd = <K extends keyof typeof DEFAULTS>(k: K, v: (typeof DEFAULTS)[K]) => setS((p) => ({ ...p, [k]: v }));

  async function start() {
    setError("");
    if (!url.trim()) return setError("Enter the website address to download.");
    if (!confirm) return setError("Please confirm that you own this website or have permission to archive it.");
    if (authEnabled && profiles.length === 0) return setError("Add at least one login profile, or turn authentication off.");
    if (authEnabled && profiles.some((p) => !p.name.trim() || !p.loginUrl.trim())) return setError("Each profile needs a name and a login page URL.");
    if (authEnabled && profiles.some((p) => p.method === "form" && (!p.username.trim() || !p.password || !p.authenticatedSelector.trim()))) return setError("Automated form logins need credentials and an authenticated-state selector.");
    if (authEnabled && authMode === "combined" && profiles.length < 2) return setError("Combined discovery needs at least two login profiles.");
    setBusy(true);
    try {
      const options = {
        maxDepth: s.maxDepth,
        maxPages: s.maxPages,
        maxFileSize: s.maxFileSizeMb * 1048576,
        maxTotalSize: s.maxTotalSizeMb * 1048576,
        delayMs: s.delayMs,
        concurrency: s.concurrency,
        renderMode: s.renderMode,
        includeSubdomains: s.includeSubdomains,
        crawlQueryParams: s.crawlQueryParams,
        useSitemap: s.useSitemap,
        downloadAssets: s.downloadAssets,
        externalAssets: s.externalAssets,
        respectRobots: s.respectRobots,
        visualCompare: s.visualCompare,
        apiDiscovery: s.apiDiscovery,
        apiFollowPagination: s.apiFollowPagination,
        graphqlEndpoints: list(s.graphqlEndpoints),
        includePatterns: list(s.includePatterns),
        excludePatterns: list(s.excludePatterns),
        stripParams: list(s.stripParams),
        denyParams: list(s.denyParams),
        allowParams: list(s.allowParams),
        maxQueryVariantsPerPath: s.maxQueryVariantsPerPath,
        retries: s.retries,
      };
      const headers: Record<string, string> = { "content-type": "application/json" };
      // Profile ids are assigned by the server; the client never names them.
      const authProfiles = authEnabled ? profiles.map(({ name, loginUrl, username, password, loginButtonSelector, usernameSelector, passwordSelector, authenticatedSelector, mfaSelector, allowedAuthOrigins, method }) => ({ name, loginUrl, username, password, loginButtonSelector, usernameSelector, passwordSelector, authenticatedSelector, mfaSelector, allowedAuthOrigins, method })) : undefined;
      const r = await api("/api/crawl", { method: "POST", headers, body: JSON.stringify({ url, options, confirmPermission: true, ...(authProfiles ? { authProfiles, authMode } : {}) }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not start the crawl");
      setJob(null);
      setActiveId(d.id);
      if (authEnabled) setProfiles((current) => current.map((p, i) => ({ ...p, password: "", editing: false, jobId: d.mode === "combined" ? d.id : d.ids?.[i], status: "logging-in" })));
      if (d.workerOnline === false) setError("The crawl is queued, but no crawl worker is online right now. It starts as soon as a worker connects.");
      void loadHistory();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function updateProfile(id: string, patch: Partial<LoginProfile>) {
    setProfiles((current) => current.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function addProfile() {
    if (profiles.length >= 5) return setError("The server limit is 5 login profiles per batch.");
    setProfiles((current) => [...current, { id: crypto.randomUUID(), name: `Login ${current.length + 1}`, loginUrl: "", username: "", password: "", loginButtonSelector: "", usernameSelector: "", passwordSelector: "", authenticatedSelector: "", mfaSelector: "", allowedAuthOrigins: "", method: "form", editing: true, status: "not-configured" }]);
    setError("");
  }

  async function testProfile(profile: LoginProfile) {
    if (profile.method !== "form") return setError("A manual sign-in is verified interactively when the crawl starts.");
    if (!profile.loginUrl || !profile.username || !profile.password || !profile.authenticatedSelector) return setError("Complete the login URL, credentials, and authenticated-state selector first.");
    setTestingProfile(profile.id);
    updateProfile(profile.id, { status: "logging-in" });
    try {
      const r = await api("/api/auth/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: { name: profile.name, mfaSelector: profile.mfaSelector, loginUrl: profile.loginUrl, username: profile.username, password: profile.password, loginButtonSelector: profile.loginButtonSelector, usernameSelector: profile.usernameSelector, passwordSelector: profile.passwordSelector, authenticatedSelector: profile.authenticatedSelector, method: profile.method } }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Login verification failed");
      updateProfile(profile.id, { status: d.status === "awaiting-manual-verification" ? "awaiting-manual-verification" : "authenticated" });
    } catch (e) {
      updateProfile(profile.id, { status: "authentication-failed" });
      setError((e as Error).message);
    } finally {
      setTestingProfile(null);
    }
  }

  async function clearProfileSession(profile: LoginProfile): Promise<boolean> {
    if (!profile.jobId) return true;
    const r = await api(`/api/crawl/${profile.jobId}/auth`, { method: "POST" });
    const data = await r.json();
    if (!r.ok) { setError(data.error || "Could not clear credentials"); return false; }
    updateProfile(profile.id, { status: "not-configured" });
    void loadHistory();
    return true;
  }

  async function removeLogin(profile: LoginProfile) {
    if (profile.jobId && !(await clearProfileSession(profile))) return;
    setProfiles((current) => current.filter((p) => p.id !== profile.id));
  }

  async function control(action: "pause" | "resume" | "cancel", id = activeId) {
    if (!id) return;
    const r = await api(`/api/crawl/${id}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    if (!r.ok) setError((await r.json()).error);
    else if (action === "resume") {
      if (id !== activeId) setActiveId(id);
      setStreamKey((k) => k + 1);
    }
    void loadHistory();
  }

  async function remove(id: string) {
    const r = await api(`/api/crawl/${id}`, { method: "DELETE" });
    if (!r.ok) setError((await r.json()).error);
    if (id === activeId) {
      setActiveId(null);
      setJob(null);
      setStats(null);
    }
    void loadHistory();
  }

  const status = job?.status ?? stats?.status ?? "";
  // While the worker waits for the user to sign in, the crawl is technically paused; say what it is actually waiting for.
  const awaitingLogin = loginSessions.some((l) => l.status === "awaiting-user");
  const active = status === "running" || status === "paused" || status === "queued";
  const pct = stats ? Math.round(stats.progress * 100) : 0;
  const tiles = useMemo(
    () =>
      stats
        ? [
            ["Pages discovered", stats.pagesDiscovered],
            ["Pages crawled", stats.pagesCrawled],
            ["Pages remaining", stats.pagesRemaining],
            ["Assets discovered", stats.assetsDiscovered],
            ["Assets downloaded", stats.assetsDownloaded],
            ["Failed URLs", stats.pagesFailed + stats.assetsFailed],
            ["Duplicates (URLs / assets)", `${stats.duplicateUrls} / ${stats.duplicateAssets}`],
            ["Skipped", stats.pagesSkipped],
            ["Downloaded", fmtBytes(stats.bytesDownloaded)],
            ["Speed", `${fmtBytes(stats.speedBps)}/s`],
            ["Depth reached", stats.maxDepthReached],
            ["Elapsed", fmtTime(stats.elapsedMs)],
          ]
        : [],
    [stats],
  );

  const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200";
  const label = "block text-xs font-medium text-slate-600 mb-1";
  const check = (k: keyof typeof DEFAULTS, text: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm text-slate-700" title={hint}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600" checked={s[k] as boolean} onChange={(e) => upd(k, e.target.checked as never)} />
      <span>{text}</span>
    </label>
  );
  const num = (k: keyof typeof DEFAULTS, text: string, min = 0, max = 100000) => (
    <div>
      <label className={label}>{text}</label>
      <input type="number" className={input} min={min} max={max} value={s[k] as number} onChange={(e) => upd(k, Number(e.target.value) as never)} />
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-100 bg-[length:100%_420px] bg-no-repeat">
      <header className="mx-auto max-w-6xl px-4 pt-12 pb-8 text-center text-white">
        <div className="mb-4 flex flex-wrap items-center justify-end gap-3 text-xs text-slate-300">
          {!features.workerOnline && <span className="rounded-full bg-amber-500/20 px-3 py-1 text-amber-200">No crawl worker online</span>}
          <span>{userEmail}</span>
          <button type="button" onClick={onSignOut} className="rounded-full bg-white/10 px-3 py-1 text-white hover:bg-white/20">Sign out</button>
        </div>
        <p className="mb-3 inline-block rounded-full bg-white/10 px-3 py-1 text-xs tracking-wide text-indigo-200">Deep crawler · Offline cloner · v3.1</p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">Universal Clone</h1>
        <p className="mx-auto mt-3 max-w-2xl text-slate-300">Enter one URL. The crawler discovers in-scope pages, downloads eligible assets, rewrites links for offline use and packages everything as a ZIP. Authorized login profiles run in isolated browser sessions; you sign in yourself whenever a site asks for MFA.</p>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 pb-16">
        <section className="rounded-2xl bg-white p-5 shadow-xl ring-1 ring-slate-200">
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              className={`${input} !py-3 text-base`}
              placeholder="https://example.com/"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && start()}
              aria-label="Website URL"
            />
            <button onClick={start} disabled={busy || active} className="rounded-lg bg-indigo-600 px-6 py-3 font-semibold text-white shadow hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">
              {busy ? "Starting…" : "Start download"}
            </button>
          </div>
          <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <summary className="cursor-pointer font-semibold text-slate-800">Authentication / Login Settings</summary>
            <div className="mt-4 space-y-4">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-indigo-600" checked={authEnabled} onChange={(e) => setAuthEnabled(e.target.checked)} />
                Enable Authentication
              </label>
              {authEnabled && <>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  Use only accounts you are authorised to use. Credentials are encrypted on the server, tied to this crawl and deleted when it finishes. CAPTCHA and MFA are never bypassed: when a site asks for them, the crawl pauses and you complete the step yourself in an isolated browser.
                  {!features.authenticatedCrawling && <b className="mt-1 block">Authenticated crawling is disabled on this server (no credential-encryption key is configured).</b>}
                </div>
                {profiles.length >= 2 && (
                  <div>
                    <label className={label}>How should several profiles be crawled?</label>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {([["separate", "Separate archives", "One independent crawl and ZIP per profile."], ["combined", "Combined discovery", "URLs found by any profile are tried with every profile. One ZIP with a folder per profile and a report of who can open which page. Accounts stay isolated."]] as const).map(([v, t, d]) => (
                        <button key={v} type="button" onClick={() => setAuthMode(v)} className={`rounded-lg border p-3 text-left text-sm ${authMode === v ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200" : "border-slate-300 bg-white hover:bg-slate-50"}`}>
                          <b className="block">{t}</b>
                          <span className="text-xs text-slate-600">{d}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold text-slate-800">Login Profiles ({profiles.length}/5)</h3>
                  <button type="button" onClick={addProfile} disabled={profiles.length >= 5} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">+ Add Login</button>
                </div>
                {profiles.length === 0 && <p className="text-sm text-slate-500">No profiles configured.</p>}
                {profiles.map((p) => {
                  const pjob = history.find((h) => h.id === p.jobId);
                  const live = (pjob?.id === activeId ? stats : pjob?.stats)?.profiles?.find((x) => x.name === p.name);
                  const pstatus: AuthenticationStatus = live?.status ?? (pjob?.status === "paused" && pjob.stopReason?.includes("session expired") ? "session-expired" : pjob?.status === "running" ? "crawling" : pjob?.status === "completed" ? "completed" : pjob?.status === "failed" ? "authentication-failed" : !p.loginUrl || (p.method === "form" && (!p.username || (!p.password && !p.jobId))) ? "waiting-for-credentials" : p.status);
                  const statusLabel: Record<AuthenticationStatus, string> = { "not-configured": "Not configured", "waiting-for-credentials": "Waiting for credentials", "logging-in": "Logging in", "awaiting-manual-verification": "Waiting for you to sign in / verify", authenticated: "Authenticated", "authentication-failed": "Authentication failed", "session-expired": "Session expired — resume to reauthenticate", crawling: "Crawling", completed: "Completed" };
                  return <fieldset key={p.id} className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div><b>{p.name || "Unnamed profile"}</b><span className="ml-2 rounded-full bg-slate-100 px-2 py-1 text-xs">{statusLabel[pstatus]}</span></div>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => updateProfile(p.id, { editing: !p.editing })} className="rounded border px-3 py-1 text-sm">{p.editing ? "Done editing" : "Edit Login"}</button>
                        <button type="button" onClick={() => void removeLogin(p)} className="rounded border border-rose-200 px-3 py-1 text-sm text-rose-700">Remove Login</button>
                        {p.method === "form" && features.workerMode === "inline" && <button type="button" disabled={testingProfile === p.id} onClick={() => void testProfile(p)} className="rounded border border-indigo-200 px-3 py-1 text-sm text-indigo-700 disabled:opacity-50">{testingProfile === p.id ? "Testing…" : "Test Login"}</button>}
                      </div>
                    </div>
                    <div className="mb-3 grid gap-2 sm:grid-cols-2">
                      {([["form", "Automatic form login", "The crawler fills in the email/password form. If the site then asks for MFA, you complete that step yourself."], ["manual", "Manual sign-in", "You sign in yourself in an isolated browser (SSO, MFA, CAPTCHA). No password is stored."]] as const).map(([v, t, d]) => (
                        <button key={v} type="button" disabled={!p.editing} onClick={() => updateProfile(p.id, { method: v })} className={`rounded-lg border p-2 text-left text-xs ${p.method === v ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200" : "border-slate-300 hover:bg-slate-50"} disabled:opacity-60`}>
                          <b className="block text-sm">{t}</b>
                          <span className="text-slate-600">{d}</span>
                        </button>
                      ))}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(p.method === "form"
                        ? ([ ["name", "Profile Name"], ["loginUrl", "Login Page URL"], ["username", "Email / Username"], ["password", "Password"], ["loginButtonSelector", "Login Button Selector (optional)"], ["usernameSelector", "Username Field Selector (optional)"], ["passwordSelector", "Password Field Selector (optional)"], ["authenticatedSelector", "Authenticated-state selector (required for verification)" ], ["mfaSelector", "MFA / verification page selector (optional)"], ["allowedAuthOrigins", "Extra sign-in origins for the MFA step (optional)"] ] as const)
                        : ([ ["name", "Profile Name"], ["loginUrl", "Login Page URL"], ["authenticatedSelector", "Authenticated-state selector (recommended)" ], ["allowedAuthOrigins", "Extra sign-in origins, e.g. your SSO provider (optional)"] ] as const)
                      ).map(([key, title]) => <div key={key}>
                        <label className={label}>{title}</label>
                        <input className={input} type={key === "password" ? "password" : "text"} autoComplete={key === "password" ? "new-password" : "off"} value={p[key]} disabled={!p.editing} onChange={(e) => updateProfile(p.id, { [key]: e.target.value })} placeholder={key === "authenticatedSelector" ? ".account-menu, [data-authenticated=true]" : key === "mfaSelector" ? "#otp-form, input[name=code]" : key === "allowedAuthOrigins" ? "https://login.example-sso.com" : undefined} />
                      </div>)}
                    </div>
                    <p className="mt-2 text-xs text-slate-500">{p.method === "form" ? "Login submissions are the only automated POSTs, and only to this login page origin. " : "During your manual sign-in, form submissions are allowed only to the login origin and the extra sign-in origins listed here. "}While crawling, state-changing requests are blocked.</p>
                    {p.jobId && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600"><span>Pages discovered {live?.pagesDiscovered ?? pjob?.stats?.pagesDiscovered ?? 0} · downloaded {live?.pagesDownloaded ?? pjob?.stats?.pagesCrawled ?? 0}</span><div className="flex gap-2">{pjob?.status === "paused" && <button type="button" onClick={() => void control("resume", p.jobId!)} className="rounded border px-2 py-1">Reauthenticate &amp; Resume</button>}{pjob?.hasZip && <a href={`/api/crawl/${p.jobId}/download`} className="rounded border px-2 py-1">{pjob.mode === "combined" ? "Download combined ZIP" : "Download profile ZIP"}</a>}<button type="button" onClick={() => void clearProfileSession(p)} className="rounded border px-2 py-1">Remove Credentials / Clear Session</button></div></div>}
                  </fieldset>;
                })}
              </>}
            </div>
          </details>
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>I own this website or have permission to archive it. I understand authentication, paywalls, CAPTCHAs and access controls are never bypassed.</span>
          </label>
          {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

          <button onClick={() => setShowAdv((v) => !v)} className="mt-4 text-sm font-medium text-indigo-600 hover:underline">
            {showAdv ? "▾ Hide advanced settings" : "▸ Advanced settings"}
          </button>
          {showAdv && (
            <div className="mt-4 space-y-5 border-t border-slate-200 pt-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {num("maxDepth", "Max crawl depth", 0, 20)}
                {num("maxPages", "Max pages", 1, 5000)}
                {num("maxFileSizeMb", "Max file size (MB)", 1, 200)}
                {num("maxTotalSizeMb", "Max total size (MB)", 1, 2048)}
                {num("delayMs", "Request delay (ms)", 0, 30000)}
                {num("concurrency", "Concurrent workers", 1, 8)}
                {num("retries", "Retries (backoff)", 0, 6)}
                {num("maxQueryVariantsPerPath", "Max query variants / path", 1, 500)}
              </div>
              <div>
                <label className={label}>Rendering mode</label>
                <div className="grid gap-2 sm:grid-cols-3">
                  {[
                    ["fast", "Fast HTML", "Plain HTTP + HTML parsing. Fastest; misses content built by JavaScript."],
                    ["js", "JavaScript rendering", "Chromium renders each page (React, Vue, Angular, SPA…). Saved as a static snapshot."],
                    ["full", "Full rendering", "Rendering + clicks safe “load more” controls; scripts are kept in the copy."],
                  ].map(([v, t, d]) => (
                    <button key={v} type="button" onClick={() => upd("renderMode", v)} className={`rounded-lg border p-3 text-left text-sm ${s.renderMode === v ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200" : "border-slate-300 hover:bg-slate-50"}`}>
                      <b className="block">{t}</b>
                      <span className="text-xs text-slate-600">{d}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {check("useSitemap", "Sitemap discovery (robots.txt + sitemap.xml, nested)")}
                {check("downloadAssets", "Download assets (CSS, JS, images, fonts, media, documents)")}
                {check("externalAssets", "Include assets hosted on other domains (CDNs)")}
                {check("crawlQueryParams", "Crawl query-parameter pages (?page=2, ?id=5)")}
                {check("includeSubdomains", "Crawl subdomains")}
                {check("respectRobots", "Respect robots.txt (recommended)")}
                {check("visualCompare", "Visual comparison report (needs rendering; slower)")}
                {check("apiFollowPagination", "Follow JSON pagination links (GET only, bounded)")}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className={label}>XHR / API discovery (needs a rendering mode or a login profile)</label>
                  <select className={input} value={s.apiDiscovery} onChange={(e) => upd("apiDiscovery", e.target.value)}>
                    <option value="off">Off</option>
                    <option value="metadata">List endpoints and response metadata only</option>
                    <option value="archive">Also store redacted JSON responses of GET requests</option>
                  </select>
                  <p className="mt-1 text-xs text-slate-500">Only requests the pages make themselves are recorded. State-changing requests are blocked, never replayed. Tokens, secrets and payment data are redacted.</p>
                </div>
                <div>
                  <label className={label}>Authorised GraphQL endpoints (one per line; read-only queries only)</label>
                  <textarea className={input} rows={2} placeholder="https://example.com/graphql" value={s.graphqlEndpoints} onChange={(e) => upd("graphqlEndpoints", e.target.value)} />
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className={label}>Include only URLs matching (one per line; * wildcard or /regex/)</label>
                  <textarea className={input} rows={3} placeholder="/blog*" value={s.includePatterns} onChange={(e) => upd("includePatterns", e.target.value)} />
                </div>
                <div>
                  <label className={label}>Exclude URLs matching</label>
                  <textarea className={input} rows={3} placeholder="/admin*&#10;/\.pdf$/" value={s.excludePatterns} onChange={(e) => upd("excludePatterns", e.target.value)} />
                </div>
                <div>
                  <label className={label}>Strip query parameters (tracking)</label>
                  <textarea className={input} rows={2} value={s.stripParams} onChange={(e) => upd("stripParams", e.target.value)} />
                </div>
                <div>
                  <label className={label}>Skip URLs containing these parameters</label>
                  <textarea className={input} rows={2} value={s.denyParams} onChange={(e) => upd("denyParams", e.target.value)} />
                </div>
                <div className="md:col-span-2">
                  <label className={label}>Keep only these query parameters (empty = keep all except stripped)</label>
                  <input className={input} placeholder="page, category, id" value={s.allowParams} onChange={(e) => upd("allowParams", e.target.value)} />
                </div>
              </div>
            </div>
          )}
        </section>

        {activeId && loginSessions.filter((l) => l.status === "awaiting-user").map((l) => (
          <LoginPanel key={l.id} jobId={activeId} session={l} profileName={jobProfiles.find((jp) => jp.id === l.profileId)?.name ?? "Login profile"} />
        ))}

        {(activeId || job) && (
          <section className="rounded-2xl bg-white p-5 shadow-xl ring-1 ring-slate-200" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">Live crawl</h2>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[status] ?? "bg-slate-100"}`}>{awaitingLogin && status === "paused" ? "waiting for sign-in" : status || "connecting…"}</span>
                </div>
                <p className="truncate text-sm text-slate-500">{job?.url}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {status === "running" && <button onClick={() => control("pause")} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600">Pause</button>}
                {status === "paused" && !awaitingLogin && <button onClick={() => control("resume")} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Resume</button>}
                {active && <button onClick={() => control("cancel")} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700">Cancel</button>}
                {status === "interrupted" && activeId && <button onClick={() => control("resume")} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white">Resume saved crawl</button>}
                {job?.hasZip && (
                  <a href={`/api/crawl/${job.id}/download`} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
                    ⬇ Download ZIP ({fmtBytes(job.zipBytes)})
                  </a>
                )}
              </div>
            </div>

            {stats && (
              <>
                <div className="mt-4">
                  <div className="h-3 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <div className={`h-full rounded-full transition-all ${status === "failed" ? "bg-rose-500" : "bg-indigo-600"}`} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {stats.pagesCrawled + stats.pagesFailed} of {stats.pagesCrawled + stats.pagesFailed + stats.pagesRemaining} known pages processed
                    {active ? " — the total grows as new links are found" : ""}. Actual counts, not an estimate.
                  </p>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  {tiles.map(([k, v]) => (
                    <div key={String(k)} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
                      <div className="text-xl font-bold text-slate-900">{v}</div>
                      <div className="text-xs text-slate-500">{k}</div>
                    </div>
                  ))}
                </div>
                {stats.currentUrls.length > 0 && active && (
                  <div className="mt-4 rounded-xl bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
                    <b className="text-amber-900">Currently crawling</b>
                    <ul className="mt-1 space-y-0.5 font-mono text-xs text-amber-900">
                      {stats.currentUrls.map((u) => (
                        <li key={u} className="truncate">{u}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            {(job?.error || stats?.stopReason) && (
              <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{job?.error ?? stats?.stopReason}</p>
            )}
            {job && !active && job.status !== "interrupted" && (
              <div className="mt-4 flex flex-wrap gap-2 text-sm">
                {(job.mode === "combined" ? ["combined-report.json", "access-matrix.json", "access-matrix.csv"] : ["crawl-report.html", "crawl-report.json", "failed-urls.txt", "discovered-urls.txt", "assets-manifest.json", "api-discovery.json"]).map((f) => (
                  <a key={f} className="rounded-md bg-slate-100 px-3 py-1.5 text-slate-700 ring-1 ring-slate-200 hover:bg-slate-200" href={`/api/crawl/${job.id}/report/${f}`} target="_blank" rel="noreferrer">
                    {f}
                  </a>
                ))}
              </div>
            )}

            <div className="mt-4 overflow-hidden rounded-xl bg-slate-950 ring-1 ring-slate-800">
              <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-xs text-slate-400">
                <span>Activity log</span>
                <span>{logs.length} lines</span>
              </div>
              <div
                ref={logRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                }}
                className="h-72 overflow-auto p-3 font-mono text-xs leading-5"
              >
                {logs.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">
                    <span className={`inline-block w-20 ${TAG_COLOR[l.tag] ?? "text-slate-300"}`}>[{l.tag}]</span>
                    <span className="text-slate-300">{l.message}</span>
                  </div>
                ))}
                {logs.length === 0 && <span className="text-slate-500">Waiting for events…</span>}
              </div>
            </div>
          </section>
        )}

        <section className="rounded-2xl bg-white p-5 shadow-xl ring-1 ring-slate-200">
          <h2 className="mb-3 text-lg font-semibold">Download history</h2>
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">No downloads yet. Finished archives are kept for 24 hours by default.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {history.map((h) => (
                <div key={h.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[h.status] ?? "bg-slate-100"}`}>{h.status}</span>
                      <span className="truncate text-sm font-medium text-slate-800">{h.url}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {new Date(h.createdAt).toLocaleString()} · {h.stats ? `${h.stats.pagesCrawled} pages, ${h.stats.assetsDownloaded} assets, ${h.stats.pagesFailed + h.stats.assetsFailed} failed` : "no stats"}
                      {h.hasZip ? ` · ${fmtBytes(h.zipBytes)}` : ""}
                    </p>
                    {h.error && <p className="text-xs text-rose-600">{h.error}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2 text-sm">
                    <button className="rounded-md px-3 py-1.5 ring-1 ring-slate-300 hover:bg-slate-50" onClick={() => { setActiveId(h.id); setJob(h); setStats(h.stats); }}>Open</button>
                    {h.hasZip && <a className="rounded-md bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-700" href={`/api/crawl/${h.id}/download`}>ZIP</a>}
                    {h.status === "interrupted" && <button className="rounded-md bg-emerald-600 px-3 py-1.5 text-white" onClick={() => control("resume", h.id)}>Resume</button>}
                    <button className="rounded-md px-3 py-1.5 text-rose-600 ring-1 ring-rose-200 hover:bg-rose-50" onClick={() => remove(h.id)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="text-center text-xs text-slate-500">
          Only crawl websites you own or have permission to archive. Requests to private networks and cloud metadata addresses are blocked. Some functionality (forms, logins, live APIs) cannot work offline — see the report for what was detected.
        </footer>
      </main>
    </div>
  );
}
