"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
};
type Log = { t: number; tag: string; message: string };
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
};

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
  running: "bg-sky-100 text-sky-800",
  paused: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-slate-200 text-slate-700",
  failed: "bg-rose-100 text-rose-800",
  interrupted: "bg-orange-100 text-orange-800",
};

export default function Downloader() {
  const [url, setUrl] = useState("");
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
      const r = await fetch("/api/crawl", { cache: "no-store" });
      if (r.ok) setHistory((await r.json()).jobs);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    const t = setInterval(loadHistory, 5000);
    return () => clearInterval(t);
  }, [loadHistory]);

  // Live updates via Server-Sent Events
  useEffect(() => {
    if (!activeId) return;
    setLogs([]);
    setStats(null);
    const es = new EventSource(`/api/crawl/${activeId}/events`);
    es.addEventListener("snapshot", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setJob(d.job);
      setStats(d.job.stats);
      setLogs(d.logs);
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
    es.addEventListener("done", async () => {
      es.close();
      const r = await fetch(`/api/crawl/${activeId}`, { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setJob(d.job);
        setStats(d.job.stats);
      }
      void loadHistory();
    });
    es.onerror = () => {
      /* the browser reconnects automatically; snapshot resyncs state */
    };
    return () => es.close();
  }, [activeId, loadHistory]);

  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const upd = <K extends keyof typeof DEFAULTS>(k: K, v: (typeof DEFAULTS)[K]) => setS((p) => ({ ...p, [k]: v }));

  async function start() {
    setError("");
    if (!url.trim()) return setError("Enter the website address to download.");
    if (!confirm) return setError("Please confirm that you own this website or have permission to archive it.");
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
        includePatterns: list(s.includePatterns),
        excludePatterns: list(s.excludePatterns),
        stripParams: list(s.stripParams),
        denyParams: list(s.denyParams),
        allowParams: list(s.allowParams),
        maxQueryVariantsPerPath: s.maxQueryVariantsPerPath,
        retries: s.retries,
      };
      const r = await fetch("/api/crawl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, options, confirmPermission: true }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not start the crawl");
      setJob(null);
      setActiveId(d.id);
      void loadHistory();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function control(action: "pause" | "resume" | "cancel", id = activeId) {
    if (!id) return;
    const r = await fetch(`/api/crawl/${id}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    if (!r.ok) setError((await r.json()).error);
    else if (action === "resume" && id !== activeId) setActiveId(id);
    void loadHistory();
  }

  async function remove(id: string) {
    const r = await fetch(`/api/crawl/${id}`, { method: "DELETE" });
    if (!r.ok) setError((await r.json()).error);
    if (id === activeId) {
      setActiveId(null);
      setJob(null);
      setStats(null);
    }
    void loadHistory();
  }

  const status = job?.status ?? stats?.status ?? "";
  const active = status === "running" || status === "paused";
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
        <p className="mb-3 inline-block rounded-full bg-white/10 px-3 py-1 text-xs tracking-wide text-indigo-200">Deep crawler · Offline cloner · v2</p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">Website Downloader</h1>
        <p className="mx-auto mt-3 max-w-2xl text-slate-300">Enter one URL. The crawler discovers every public page in scope, downloads the assets each page needs, rewrites links for offline use and packages everything as a ZIP.</p>
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

        {(activeId || job) && (
          <section className="rounded-2xl bg-white p-5 shadow-xl ring-1 ring-slate-200" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">Live crawl</h2>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[status] ?? "bg-slate-100"}`}>{status || "connecting…"}</span>
                </div>
                <p className="truncate text-sm text-slate-500">{job?.url}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {status === "running" && <button onClick={() => control("pause")} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600">Pause</button>}
                {status === "paused" && <button onClick={() => control("resume")} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Resume</button>}
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
                {["crawl-report.html", "crawl-report.json", "failed-urls.txt", "discovered-urls.txt", "assets-manifest.json"].map((f) => (
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
