"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

/**
 * The isolated browser of a "Login with Browser" window.
 *
 * The user sees the real website (screenshots from the worker's Chromium, about one per second) and
 * interacts with it: click the picture to focus a field, then type. Nothing is filled in, solved or
 * bypassed here — multi-page sign-ins, redirects, one-time codes and CAPTCHA prompts are all done by
 * the user on the real page.
 */

const VIEW = { width: 1280, height: 800 };
const SPECIAL = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export type BrowserLoginSession = {
  id: string;
  savedProfileId: string;
  status: string;
  message: string | null;
  pageUrl: string | null;
  frameSeq: number;
  expiresAt: string;
  /** Origins the window refused to navigate to (the profile belongs to one site only). */
  blockedOrigins?: string[];
};

export default function BrowserLoginView({
  profileName,
  targetHost,
  session,
  onSaved,
  onClose,
  onRetry,
}: {
  profileName: string;
  targetHost: string;
  session: BrowserLoginSession;
  /** Called after the worker stored the session ("Login profile saved"). */
  onSaved: (message: string) => void;
  onClose: () => void;
  /** Called when the window ended without saving, so the caller can offer another attempt. */
  onRetry: (message: string) => void;
}) {
  const [src, setSrc] = useState("");
  const [state, setState] = useState(session);
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [left, setLeft] = useState("");
  const [saving, setSaving] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const urlRef = useRef("");
  const seqRef = useRef("");
  const base = `/api/login-profiles/sessions/${session.id}`;
  const ended = state.status !== "awaiting-user";

  const refresh = useCallback(async () => {
    try {
      const r = await api(`${base}/frame`);
      if (r.status !== 200) return;
      const seq = r.headers.get("x-frame-seq") ?? "";
      if (seq === seqRef.current) return;
      seqRef.current = seq;
      const url = URL.createObjectURL(await r.blob());
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setSrc(url);
    } catch {
      /* next tick */
    }
  }, [base]);

  // Poll the window's state; when the worker captures the session the status flips to "authenticated".
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const r = await api(base);
        if (!r.ok || stopped) return;
        const d = await r.json();
        setState(d.session);
        // The worker explains why a "Use This Login" press was refused (e.g. not signed in yet).
        if (d.session.message && d.session.status === "awaiting-user") setNote((n) => (n && !n.startsWith("Checking") ? n : d.session.message));
        if (d.session.status === "authenticated") {
          onSaved(`Login profile saved for ${targetHost}`);
          return;
        }
        if (d.session.status !== "awaiting-user") {
          onRetry(d.session.message || "The sign-in window closed before a login was saved.");
        }
      } catch {
        /* keep polling */
      }
    };
    const t = window.setInterval(() => void poll(), 1500);
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
    // onSaved/onRetry are stable callbacks from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  useEffect(() => {
    if (ended) return;
    const first = window.setTimeout(() => void refresh(), 0);
    const t = window.setInterval(() => void refresh(), 800);
    const c = window.setInterval(() => {
      const ms = new Date(state.expiresAt).getTime() - Date.now();
      setLeft(ms > 0 ? `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}` : "0:00");
    }, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
      window.clearInterval(c);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [refresh, state.expiresAt, ended]);

  // Input is delivered strictly in order: one request at a time, consecutive characters merged.
  const pending = useRef<Record<string, unknown>[]>([]);
  const sending = useRef(false);
  const send = useCallback(
    async (body: Record<string, unknown>) => {
      setNote("");
      const q = pending.current;
      const ev = body.event as { type?: string; text?: string } | undefined;
      const lastEv = q[q.length - 1]?.event as { type?: string; text?: string } | undefined;
      if (body.action === "input" && ev?.type === "type" && lastEv?.type === "type" && (lastEv.text ?? "").length + (ev.text ?? "").length <= 500) {
        lastEv.text = (lastEv.text ?? "") + (ev.text ?? "");
      } else {
        q.push(body.action === "input" ? { action: "input", event: { ...(body.event as object) } } : body);
      }
      if (sending.current) return;
      sending.current = true;
      try {
        while (q.length) {
          const next = q.shift()!;
          const r = await api(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
          if (!r.ok) {
            q.length = 0;
            setNote((await r.json().catch(() => ({}))).error || "The action could not be sent.");
          }
        }
      } finally {
        sending.current = false;
      }
      window.setTimeout(() => void refresh(), 400);
    },
    [base, refresh],
  );

  function click(e: React.MouseEvent<HTMLImageElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    void send({ action: "input", event: { type: "click", x: ((e.clientX - rect.left) / rect.width) * VIEW.width, y: ((e.clientY - rect.top) / rect.height) * VIEW.height } });
    e.currentTarget.focus();
  }

  function key(e: React.KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (SPECIAL.has(e.key)) {
      e.preventDefault();
      void send({ action: "input", event: { type: "key", key: e.key } });
    } else if (e.key.length === 1) {
      e.preventDefault();
      void send({ action: "input", event: { type: "type", text: e.key } });
    }
  }

  async function saveThisLogin() {
    setSaving(true);
    setNote("");
    try {
      const r = await api(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "confirm" }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "This login could not be saved.");
      // The worker validates the session and stores it; the poll above reports the outcome.
      setNote("Checking the session…");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function cancel() {
    await api(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) }).catch(() => {});
    onClose();
  }

  async function importRequest() {
    setPasteError("");
    setPasteBusy(true);
    try {
      const r = await api(`/api/login-profiles/${session.savedProfileId}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capture: paste }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "The request could not be imported.");
      setPaste("");
      onSaved(`Login imported for ${targetHost}`);
    } catch (e) {
      setPasteError((e as Error).message);
    } finally {
      setPasteBusy(false);
    }
  }

  const btn = "min-h-11 rounded-xl px-3 py-2 text-sm font-medium text-slate-200 ring-1 ring-slate-700 hover:bg-slate-800 active:bg-slate-700";

  if (ended && state.status !== "authenticated") {
    return (
      <section aria-label="Browser sign-in" className="rounded-2xl bg-slate-900/80 p-4 ring-1 ring-slate-700 sm:p-5">
        <h3 className="text-base font-semibold text-slate-100">Sign-in window closed</h3>
        <p className="mt-1 text-sm text-slate-400">{state.message || "The sign-in was not finished."}</p>
        <button type="button" onClick={onClose} className="mt-3 rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-400">
          Back to downloads
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Browser sign-in" className="overflow-hidden rounded-2xl bg-slate-900/80 ring-1 ring-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-100">
            Sign in to {targetHost} <span className="font-normal text-slate-400">— {profileName}</span>
          </h3>
          <p className="text-xs text-slate-400">Isolated browser on the crawl worker · window closes in {left || "…"}</p>
        </div>
        <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300">Live</span>
      </div>

      <p className="px-4 pt-3 text-xs leading-5 text-slate-400">
        This is the real website in a private browser. Click the page to focus a field, then type — including any one-time code, SSO screen or
        CAPTCHA the site shows. Nothing is solved or bypassed for you. When you are signed in, press <b className="text-slate-200">Use This Login</b>.
      </p>

      {state.pageUrl && (
        <p className="mx-4 mt-2 truncate rounded-lg bg-slate-950/70 px-2.5 py-1.5 font-mono text-[11px] text-slate-400 ring-1 ring-slate-800" aria-label="Current page">
          {state.pageUrl}
        </p>
      )}

      <div className="mx-4 mt-2 overflow-hidden rounded-xl bg-slate-950 ring-1 ring-slate-800">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={`Live view of ${targetHost}. Click a field to focus it, then type.`}
            tabIndex={0}
            onClick={click}
            onKeyDown={key}
            onWheel={(e) => void send({ action: "input", event: { type: "scroll", dy: Math.max(-1500, Math.min(1500, e.deltaY)) } })}
            className="block w-full cursor-crosshair outline-none focus:ring-2 focus:ring-indigo-400"
            style={{ aspectRatio: `${VIEW.width} / ${VIEW.height}`, touchAction: "manipulation" }}
            draggable={false}
          />
        ) : (
          <div className="flex items-center justify-center text-sm text-slate-500" style={{ aspectRatio: `${VIEW.width} / ${VIEW.height}` }}>
            Starting the isolated browser…
          </div>
        )}
      </div>

      <form
        className="mx-4 mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text) void send({ action: "input", event: { type: "type", text } });
          setText("");
        }}
      >
        <input
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none"
          type="password"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type or paste into the focused field"
          aria-label="Text to send to the focused field"
        />
        <button type="submit" className={btn}>
          Send
        </button>
        <button type="button" className={btn} onClick={() => void send({ action: "input", event: { type: "key", key: "Enter" } })}>
          Enter
        </button>
        <button type="button" className={btn} onClick={() => void send({ action: "input", event: { type: "key", key: "Tab" } })}>
          Tab
        </button>
        <button type="button" className={btn} onClick={() => void send({ action: "input", event: { type: "back" } })} aria-label="Back">
          ‹
        </button>
        <button type="button" className={btn} onClick={() => void send({ action: "input", event: { type: "reload" } })} aria-label="Reload">
          ⟳
        </button>
      </form>

      {(state.blockedOrigins?.length ?? 0) > 0 && (
        <p className="mx-4 mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-500/30">
          Navigation away from {targetHost} was blocked: {(state.blockedOrigins ?? []).join(", ")}. A saved login only ever belongs to this site.
        </p>
      )}
      {note && (
        <p role="status" className="mx-4 mt-2 text-xs text-amber-200">
          {note}
        </p>
      )}

      <div className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800 bg-slate-900/95 px-4 py-3 backdrop-blur">
        <button type="button" onClick={() => void saveThisLogin()} disabled={saving} className="min-h-12 flex-1 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-bold text-slate-950 shadow-lg hover:bg-emerald-400 disabled:opacity-50">
          {saving ? "Checking…" : "Use This Login"}
        </button>
        <button type="button" onClick={() => void cancel()} className="min-h-12 rounded-xl px-4 py-3 text-sm font-medium text-slate-300 ring-1 ring-slate-700 hover:bg-slate-800">
          Cancel
        </button>
        <button type="button" onClick={() => setShowPaste((v) => !v)} className="min-h-12 rounded-xl px-3 py-3 text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline">
          Sign-in not saved?
        </button>
      </div>

      {showPaste && (
        <div className="border-t border-slate-800 px-4 py-3">
          <label htmlFor="request-capture" className="block text-xs font-medium text-slate-300">
            Paste a signed-in request from your browser
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Some sites bind a login to the device that created it, so a headless browser cannot hold it. Sign in to {targetHost} in your own
            browser, open DevTools → Network, right-click a signed-in request → <i>Copy as cURL</i>, and paste it here. Only its cookies are kept.
          </p>
          <textarea
            id="request-capture"
            className="mt-2 h-24 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-[11px] text-slate-200 focus:border-indigo-400 focus:outline-none"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="curl 'https://…' -H 'cookie: sid=…'"
            spellCheck={false}
          />
          {pasteError && (
            <p role="alert" className="mt-1 text-xs text-rose-300">
              {pasteError}
            </p>
          )}
          <button type="button" onClick={() => void importRequest()} disabled={pasteBusy || !paste.trim()} className="mt-2 min-h-11 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-50">
            {pasteBusy ? "Importing…" : "Import login from request"}
          </button>
        </div>
      )}
    </section>
  );
}
