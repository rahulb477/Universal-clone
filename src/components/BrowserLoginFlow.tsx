"use client";

import { useCallback, useEffect, useState } from "react";
import { api, hostMatchesAddress } from "@/lib/client";
import SavedLoginPanel, { type ProfileFeatures, type SavedProfile } from "./SavedLoginPanel";

/**
 * The "Login with Browser" step of the start form: lists the signed-in user's saved logins, lets
 * them be created / renewed / deleted, and reports which ones the upcoming crawl should use.
 *
 * It only ever talks to /api/login-profiles; the session material itself stays on the server.
 */
export default function BrowserLoginFlow({
  url,
  selected,
  onSelectedChange,
  onNotice,
  features,
  refreshToken,
}: {
  url: string;
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
  onNotice: (message: string) => void;
  features: ProfileFeatures | null;
  /** Bump to reload the list (e.g. after the sign-in window saved a session). */
  refreshToken: number;
}) {
  const [profiles, setProfiles] = useState<SavedProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // The server is the authority on what this deployment can do (encryption key, worker online).
  const [serverFeatures, setServerFeatures] = useState<ProfileFeatures | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api("/api/login-profiles");
      if (!r.ok) {
        setLoadError((await r.json().catch(() => ({}))).error || "Saved logins could not be loaded.");
        return;
      }
      const d = await r.json();
      setProfiles(d.profiles ?? []);
      if (d.features) setServerFeatures(d.features);
      setLoadError("");
    } catch {
      setLoadError("Saved logins could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [load, refreshToken]);

  // Drop selections whose profile was deleted or no longer belongs to the typed address. Selections
  // are kept when the address does not parse yet (the user is still typing it).
  useEffect(() => {
    if (!selected.length || !url.trim()) return;
    const stillValid = selected.filter((id) => {
      const p = profiles.find((x) => x.id === id);
      if (!p) return false;
      // An address that does not parse yet is not a reason to drop the user's choice.
      let valid = false;
      try {
        new URL(url);
        valid = true;
      } catch {
        return true;
      }
      return valid && hostMatchesAddress(p.targetHost, p.matchSubdomains, url);
    });
    if (stillValid.length !== selected.length) onSelectedChange(stillValid);
    // The parent passes a new callback every render; only a change of address or profile list can
    // invalidate a selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, url]);

  function toggle(id: string) {
    onSelectedChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id].slice(0, 5));
  }

  return (
    <div className="space-y-3">
      {loadError && (
        <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30">
          {loadError}
        </p>
      )}
      <SavedLoginPanel
        profiles={profiles}
        loading={loading}
        url={url}
        selected={selected}
        onToggle={toggle}
        onReload={load}
        onSaved={onNotice}
        features={serverFeatures ?? features}
      />
      {profiles.length > 0 && (
        <p className="text-xs text-slate-400">
          {selected.length === 0
            ? "No saved login selected — the crawl will only reach public pages."
            : `${selected.length} saved login${selected.length === 1 ? "" : "s"} will be attached to this download.`}
        </p>
      )}
    </div>
  );
}
