"use client";

import { useState, type FormEvent } from "react";

const INPUT =
  "mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";
const BUTTON =
  "inline-flex w-full items-center justify-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";
const ERROR =
  "rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300";

// Full navigation, not router.push: this project's documented next/navigation workaround
// (see client-switcher.tsx). The destination comes from the server's reply.
function go(to: string) {
  window.location.assign(to);
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

export function LoginForm({ next }: { next: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post("/api/auth/login", { email, password, next });
      if (ok && typeof data.redirect === "string") return go(data.redirect);
      setError(typeof data.error === "string" ? data.error : "Sign-in didn't work. Try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Email
        <input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={INPUT}
        />
      </label>
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={INPUT}
        />
      </label>
      {error && <div className={ERROR}>{error}</div>}
      <button type="submit" disabled={busy} className={BUTTON}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function ChangePasswordForm({ forced, minLength }: { forced: boolean; minLength: number }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirm) return setError("The two new passwords don't match.");
    setBusy(true);
    try {
      const { ok, data } = await post("/api/auth/password", { current, next });
      if (ok) {
        if (forced) return go("/clients");
        setDone(true);
        setCurrent("");
        setNext("");
        setConfirm("");
      } else {
        setError(typeof data.error === "string" ? data.error : "That didn't work. Try again.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="max-w-sm space-y-4">
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {forced ? "Password you were given" : "Current password"}
        <input
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={INPUT}
        />
      </label>
      <div>
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={minLength}
            aria-describedby="new-password-hint"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className={INPUT}
          />
        </label>
        <p id="new-password-hint" className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          At least {minLength} characters.
        </p>
      </div>
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        New password again
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={INPUT}
        />
      </label>
      {error && <div className={ERROR}>{error}</div>}
      {done && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
          Password changed. You stay signed in here, and every other browser was signed out.
        </div>
      )}
      <button type="submit" disabled={busy} className={BUTTON}>
        {busy ? "Saving…" : forced ? "Set password and continue" : "Change password"}
      </button>
    </form>
  );
}

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      await post("/api/auth/logout", {});
    } finally {
      go("/login");
    }
  }
  return (
    <button
      type="button"
      onClick={logout}
      disabled={busy}
      className="font-medium text-zinc-600 hover:text-zinc-900 hover:underline disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
    >
      {busy ? "Logging out…" : "Log out"}
    </button>
  );
}
