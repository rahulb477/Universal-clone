"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

export type LoginSessionInfo = { id: string; profileId: string; reason: string; status: string; message: string | null; pageUrl: string | null; expiresAt: string };

const VIEW = { width: 1280, height: 800 };
const SPECIAL = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * Remote view of the isolated sign-in browser that the worker holds open for one profile.
 * The user signs in (and answers any MFA / CAPTCHA prompt) personally: clicks and keystrokes are
 * forwarded as-is, nothing is filled in or solved automatically.
 */
export default function LoginPanel({ jobId, session, profileName }: { jobId: string; session: LoginSessionInfo; profileName: string }) {
  const [src, setSrc] = useState("");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [left, setLeft] = useState("");
  const urlRef = useRef("");
  const seqRef = useRef("");
  const base = `/api/crawl/${jobId}/login/${session.id}`;

  const refresh = useCallback(async () => {
    try {
      const r = await api(`${base}/frame`);
      if (r.status !== 200) return; // 204: nothing to show (yet / any more)
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

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const t = window.setInterval(() => void refresh(), 800);
    const c = window.setInterval(() => {
      const ms = new Date(session.expiresAt).getTime() - Date.now();
      setLeft(ms > 0 ? `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}` : "0:00");
    }, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
      window.clearInterval(c);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [refresh, session.expiresAt]);

  // Input is delivered strictly in order: one request at a time, consecutive typed characters merged.
  const pending = useRef<Record<string, unknown>[]>([]);
  const sending = useRef(false);
  const send = useCallback(
    async (body: Record<string, unknown>) => {
      setNote("");
      const q = pending.current;
      const ev = body.event as { type?: string; text?: string } | undefined;
      const lastEv = q[q.length - 1]?.event as { type?: string; text?: string } | undefined;
      if (body.action === "input" && ev?.type === "type" && lastEv?.type === "type" && (lastEv.text ?? "").length + (ev.text ?? "").length <= 500) lastEv.text = (lastEv.text ?? "") + (ev.text ?? "");
      else q.push(body.action === "input" ? { action: "input", event: { ...(body.event as object) } } : body);
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
      window.setTimeout(() => void refresh(), 500);
    },
    [base, refresh],
  );

  function click(e: React.MouseEvent<HTMLImageElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * VIEW.width;
    const y = ((e.clientY - rect.top) / rect.height) * VIEW.height;
    void send({ action: "input", event: { type: "click", x, y } });
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

  const btn = "rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm hover:bg-slate-800/50";
  return (
    <section className="rounded-2xl border-2 border-amber-500/50 bg-amber-500/10 p-4 shadow" aria-label="Manual sign-in">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-amber-200">
          {session.reason === "mfa" ? "Verification step required" : session.reason === "reauthentication" ? "Sign in again" : "Sign in"} — {profileName}
        </h2>
        <span className="text-xs text-amber-200">Window closes in {left || "…"}</span>
      </div>
      <p className="mt-1 text-sm text-amber-200">
        This is an isolated browser running on the crawl worker. Sign in yourself, including any one-time code or CAPTCHA the site asks for — nothing is solved or bypassed for you. The crawl continues automatically once the signed-in state is detected.
      </p>
      {session.pageUrl && <p className="mt-2 truncate rounded bg-slate-900 px-2 py-1 font-mono text-xs text-slate-400 ring-1 ring-amber-500/40">{session.pageUrl}</p>}
      <div className="mt-2 overflow-hidden rounded-lg bg-slate-800 ring-1 ring-slate-700">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="Remote sign-in browser. Click to interact, then type." tabIndex={0} onClick={click} onKeyDown={key} onWheel={(e) => void send({ action: "input", event: { type: "scroll", dy: Math.max(-2000, Math.min(2000, e.deltaY)) } })} className="block w-full cursor-crosshair outline-none focus:ring-2 focus:ring-indigo-400" style={{ aspectRatio: `${VIEW.width} / ${VIEW.height}` }} draggable={false} />
        ) : (
          <div className="flex items-center justify-center text-sm text-slate-500" style={{ aspectRatio: `${VIEW.width} / ${VIEW.height}` }}>Waiting for the browser…</div>
        )}
      </div>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text) void send({ action: "input", event: { type: "type", text } });
          setText("");
        }}
      >
        <input className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm" type="password" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type or paste text for the focused field, then press Send" aria-label="Text to send to the focused field" />
        <button type="submit" className={btn}>Send text</button>
        <button type="button" className={btn} onClick={() => void send({ action: "input", event: { type: "key", key: "Enter" } })}>Enter</button>
        <button type="button" className={btn} onClick={() => void send({ action: "input", event: { type: "key", key: "Tab" } })}>Tab</button>
        <button type="button" className={btn} onClick={() => void send({ action: "input", event: { type: "back" } })}>Back</button>
        <button type="button" className={btn} onClick={() => void send({ action: "input", event: { type: "reload" } })}>Reload</button>
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700" onClick={() => void send({ action: "confirm" })}>I have finished signing in</button>
        <button type="button" className="rounded-lg border border-rose-300 bg-slate-900 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/10" onClick={() => void send({ action: "cancel" })}>Cancel sign-in</button>
        {(note || session.message) && <span role="status" className="text-sm text-amber-200">{note || session.message}</span>}
      </div>
    </section>
  );
}
