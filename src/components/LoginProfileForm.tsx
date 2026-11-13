"use client";

import { useState } from "react";

export type ProfileDraft = { id?: string; name: string; targetHost: string; startUrl: string };

const input = "w-full rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30";

/** One form, used both to save a new profile and to rename an existing one. */
export default function LoginProfileForm({
  initial,
  suggestName,
  onSubmit,
  onCancel,
  busy,
  error,
}: {
  initial?: ProfileDraft;
  suggestName?: string;
  onSubmit: (draft: { name: string; address: string }) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string;
}) {
  const [name, setName] = useState(initial?.name ?? suggestName ?? "");
  const [address, setAddress] = useState(initial ? initial.startUrl.replace(/\/$/, "") : "");
  const renaming = !!initial;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name: name.trim(), address: address.trim() });
      }}
    >
      <div>
        <label htmlFor="profile-name" className="mb-1 block text-xs font-medium text-slate-400">
          Profile name
        </label>
        <input id="profile-name" className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work account" maxLength={80} required autoComplete="off" />
      </div>
      {!renaming && (
        <div>
          <label htmlFor="profile-site" className="mb-1 block text-xs font-medium text-slate-400">
            Website this login belongs to
          </label>
          <input id="profile-site" className={input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://app.example.com" inputMode="url" required autoComplete="off" spellCheck={false} />
          <p className="mt-1 text-xs text-slate-500">The saved login stays locked to this site; another site can never use it.</p>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-indigo-400 disabled:opacity-50">
          {busy ? "Saving…" : renaming ? "Save name" : "Create profile"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-300 ring-1 ring-slate-700 hover:bg-slate-800">
          Cancel
        </button>
      </div>
    </form>
  );
}
