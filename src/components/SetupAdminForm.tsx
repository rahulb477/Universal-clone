"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

/**
 * First-administrator form.
 *
 * The client-side checks exist only to give fast, clear feedback; POST /api/auth/setup validates
 * everything again (key, email, password policy, confirmation, one-time rule). The setup key is
 * passed straight to the request body, is used with type="password", and is never stored in
 * localStorage or a URL. `autoComplete="off"` keeps Android/Chrome from offering to save it.
 */

const MIN_PASSWORD = 12;

function passwordProblems(password: string, email: string): string[] {
  const problems: string[] = [];
  if (!password) return problems;
  if (password.length < MIN_PASSWORD) problems.push(`Use at least ${MIN_PASSWORD} characters.`);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) problems.push("Mix upper case, lower case, digits and symbols (at least three kinds).");
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 3 && password.toLowerCase().includes(local)) problems.push("Do not include your email address in the password.");
  return problems;
}

type Stage = "form" | "done";

export default function SetupAdminForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>("form");
  const [createdEmail, setCreatedEmail] = useState("");

  const hints = useMemo(() => passwordProblems(password, email), [password, email]);
  const mismatch = confirmPassword.length > 0 && confirmPassword !== password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.trim()) return setError("Enter an email address.");
    if (hints.length) return setError(hints[0]);
    if (password !== confirmPassword) return setError("The password confirmation does not match.");
    if (!setupKey.trim()) return setError("Enter the setup key from your deployment settings.");

    setBusy(true);
    try {
      const r = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupKey, email, password, confirmPassword }),
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; user?: { email?: string } };
      if (!r.ok) {
        setError(data.error || (r.status === 409 ? "First-administrator setup has already been completed." : "Setup failed. Try again."));
        // Never keep a rejected secret in the field.
        if (r.status === 403 || r.status === 409 || r.status === 429) setSetupKey("");
        return;
      }
      setPassword("");
      setConfirmPassword("");
      setSetupKey("");
      setCreatedEmail(data.user?.email ?? email);
      setStage("done");
      // The administrator is not signed in automatically; the sign-in page is the next step.
      router.prefetch("/");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (stage === "done") {
    return (
      <section aria-label="Setup complete" className="space-y-4">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xl text-emerald-300">✓</span>
          <h2 className="text-lg font-semibold text-slate-50">Administrator created</h2>
        </div>
        <p className="text-sm text-slate-400">
          <span className="font-medium text-slate-50">{createdEmail}</span> now has the administrator role. First-administrator setup is disabled from now on.
        </p>
        <Link href="/" className="block w-full rounded-lg bg-indigo-600 px-4 py-3 text-center font-semibold text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-300">
          Continue to sign in
        </Link>
        <p className="text-xs text-slate-500">
          Sign in with the email address and password you just chose.
        </p>
        <button type="button" onClick={() => window.location.reload()} className="block w-full text-center text-xs text-slate-500 underline hover:text-slate-100">
          Reload this page
        </button>
      </section>
    );
  }

  const label = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400";
  const input =
    "w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-base text-slate-50 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 disabled:bg-slate-800/50";
  const toggle = "shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800/50 focus:outline-none focus:ring-2 focus:ring-indigo-300";

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-slate-50">Create the first administrator</h2>
        <p className="mt-1 text-sm text-slate-400">This can be done once. Use the setup key from the deployment&apos;s environment variables.</p>
      </header>

      <div>
        <label className={label} htmlFor="setup-email">
          Email
        </label>
        <input
          id="setup-email"
          className={input}
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </div>

      <div>
        <label className={label} htmlFor="setup-password">
          Password
        </label>
        <div className="flex gap-2">
          <input
            id="setup-password"
            className={input}
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            placeholder={`At least ${MIN_PASSWORD} characters`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            aria-describedby="setup-password-hint"
          />
          <button type="button" className={toggle} onClick={() => setShowPassword((v) => !v)} aria-pressed={showPassword} aria-controls="setup-password">
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
        <div id="setup-password-hint" className="mt-1 space-y-0.5">
          {password.length === 0 ? (
            <p className="text-xs text-slate-500">12+ characters, mixing upper case, lower case, digits and symbols.</p>
          ) : hints.length ? (
            hints.map((h) => (
              <p key={h} className="text-xs text-amber-700">
                {h}
              </p>
            ))
          ) : (
            <p className="text-xs text-emerald-300">Strong password.</p>
          )}
        </div>
      </div>

      <div>
        <label className={label} htmlFor="setup-confirm">
          Confirm password
        </label>
        <div className="flex gap-2">
          <input
            id="setup-confirm"
            className={input}
            type={showConfirm ? "text" : "password"}
            autoComplete="new-password"
            required
            placeholder="Repeat the password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={busy}
            aria-invalid={mismatch}
            aria-describedby={mismatch ? "setup-confirm-error" : undefined}
          />
          <button type="button" className={toggle} onClick={() => setShowConfirm((v) => !v)} aria-pressed={showConfirm} aria-controls="setup-confirm">
            {showConfirm ? "Hide" : "Show"}
          </button>
        </div>
        {mismatch && (
          <p id="setup-confirm-error" className="mt-1 text-xs text-rose-300">
            The passwords do not match.
          </p>
        )}
      </div>

      <div>
        <label className={label} htmlFor="setup-key">
          Setup key
        </label>
        <div className="flex gap-2">
          <input
            id="setup-key"
            className={`${input} font-mono text-sm`}
            type={showKey ? "text" : "password"}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            placeholder="Setup key"
            value={setupKey}
            onChange={(e) => setSetupKey(e.target.value)}
            disabled={busy}
          />
          <button type="button" className={toggle} onClick={() => setShowKey((v) => !v)} aria-pressed={showKey} aria-controls="setup-key">
            {showKey ? "Hide" : "Show"}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500">Send it once to the server for verification. It is not stored in this browser.</p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/40">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:opacity-60"
      >
        {busy && <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
        {busy ? "Creating administrator…" : "Create administrator"}
      </button>

      <Link href="/" className="block text-center text-sm text-slate-500 underline hover:text-slate-100">
        I already have an account — sign in
      </Link>
    </form>
  );
}
