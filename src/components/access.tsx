"use client";

import { useState, type FormEvent } from "react";

const INPUT =
  "block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";
const BTN_PRIMARY =
  "inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";
const BTN_SECONDARY =
  "inline-flex items-center rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900";
const BTN_DANGER =
  "inline-flex items-center rounded-full border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-zinc-950 dark:text-red-400 dark:hover:bg-red-950";
const ERROR =
  "mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300";

async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}
const errorOf = (data: Record<string, unknown>) =>
  typeof data.error === "string" ? data.error : "That didn't work. Try again.";

/** A date and time in the viewer's own timezone. */
export function LocalTime({ iso }: { iso: string | null }) {
  if (!iso) return <span>Never</span>;
  return (
    <span suppressHydrationWarning>
      {new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
    </span>
  );
}

/** A generated password, shown once with a Copy button. */
export function PasswordReveal({ email, password, note }: { email: string; password: string; note: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
      <p>
        Password for <strong>{email}</strong>:
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <code className="rounded-md border border-green-300 bg-white px-3 py-1.5 font-mono text-base tracking-wide text-zinc-900 dark:border-green-800 dark:bg-zinc-950 dark:text-zinc-100">
          {password}
        </code>
        <button type="button" onClick={copy} className={BTN_SECONDARY}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-2 text-xs">Copy it now: it isn&apos;t stored and won&apos;t be shown again. {note}</p>
    </div>
  );
}

export interface TeamMember {
  id: string;
  name: string | null;
  email: string;
  lastLoginAt: string | null;
  disabled: boolean;
  mustChangePassword: boolean;
}

export function TeamAccess({ viewerId, members }: { viewerId: string; members: TeamMember[] }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ email: string; password: string } | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy("add");
    setError(null);
    const { ok, data } = await call("POST", "/api/access/users", { role: "TEAM", name, email });
    setBusy(null);
    if (!ok) return setError(errorOf(data));
    setRevealed({ email: email.trim().toLowerCase(), password: String(data.password) });
    setName("");
    setEmail("");
  }

  async function act(m: TeamMember, action: "reset" | "toggle" | "remove") {
    if (action === "remove" && !window.confirm(`Remove ${m.email}'s login? They won't be able to sign in.`)) return;
    setBusy(`${action}:${m.id}`);
    setError(null);
    const res =
      action === "remove"
        ? await call("DELETE", `/api/access/users/${m.id}`)
        : await call("PATCH", `/api/access/users/${m.id}`, action === "reset" ? { resetPassword: true } : { disabled: !m.disabled });
    setBusy(null);
    if (!res.ok) return setError(errorOf(res.data));
    if (action === "reset") return setRevealed({ email: m.email, password: String(res.data.password) });
    window.location.reload();
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Last signed in</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {members.map((m) => (
              <tr key={m.id} className="bg-white dark:bg-zinc-950">
                <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                  {m.name ?? "—"}
                  {m.id === viewerId && <span className="ml-1 text-xs text-zinc-500">(you)</span>}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{m.email}</td>
                <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                  <LocalTime iso={m.lastLoginAt} />
                </td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                  {m.disabled ? "Turned off" : m.mustChangePassword ? "Hasn't set a password yet" : "Active"}
                </td>
                <td className="px-4 py-3">
                  {m.id !== viewerId && (
                    <div className="flex flex-wrap justify-end gap-2">
                      <button type="button" disabled={busy !== null} onClick={() => act(m, "reset")} className={BTN_SECONDARY}>
                        Reset password
                      </button>
                      <button type="button" disabled={busy !== null} onClick={() => act(m, "toggle")} className={BTN_SECONDARY}>
                        {m.disabled ? "Turn on" : "Turn off"}
                      </button>
                      <button type="button" disabled={busy !== null} onClick={() => act(m, "remove")} className={BTN_DANGER}>
                        Remove
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={add} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={`mt-1 ${INPUT}`} />
        </label>
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`mt-1 ${INPUT}`}
          />
        </label>
        <button type="submit" disabled={busy !== null || !email.trim()} className={BTN_PRIMARY}>
          {busy === "add" ? "Adding…" : "+ Add team member"}
        </button>
      </form>
      {error && <div className={ERROR}>{error}</div>}
      {revealed && (
        <PasswordReveal
          email={revealed.email}
          password={revealed.password}
          note="Send it to them; they'll choose their own password when they first sign in."
        />
      )}
    </div>
  );
}

export interface ClientLogin {
  id: string;
  email: string;
  allowedTabs: string[];
  disabled: boolean;
  lastLoginAt: string | null;
}

export function ClientAccessEditor({
  client,
  login,
  tabs,
  defaultTabs,
}: {
  client: { id: string; name: string; archived: boolean };
  login: ClientLogin | null;
  tabs: { segment: string; label: string }[];
  defaultTabs: string[];
}) {
  const [email, setEmail] = useState(login?.email ?? "");
  const [chosen, setChosen] = useState<Set<string>>(new Set(login ? login.allowedTabs : defaultTabs));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ email: string; password: string } | null>(null);

  const tabsInOrder = tabs.map((t) => t.segment).filter((s) => chosen.has(s));
  const changed =
    login && (email.trim().toLowerCase() !== login.email || tabsInOrder.join(",") !== login.allowedTabs.join(","));

  function toggle(segment: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(segment)) next.delete(segment);
      else next.add(segment);
      return next;
    });
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy("create");
    setError(null);
    const { ok, data } = await call("POST", "/api/access/users", {
      role: "CLIENT",
      clientId: client.id,
      email,
      allowedTabs: tabsInOrder,
    });
    setBusy(null);
    if (!ok) return setError(errorOf(data));
    setRevealed({ email: email.trim().toLowerCase(), password: String(data.password) });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!login) return;
    setBusy("save");
    setError(null);
    const { ok, data } = await call("PATCH", `/api/access/users/${login.id}`, { email, allowedTabs: tabsInOrder });
    setBusy(null);
    if (!ok) return setError(errorOf(data));
    window.location.reload();
  }

  async function act(action: "reset" | "toggle" | "remove") {
    if (!login) return;
    if (action === "remove" && !window.confirm(`Remove ${client.name}'s login? It stops working right away.`)) return;
    setBusy(action);
    setError(null);
    const res =
      action === "remove"
        ? await call("DELETE", `/api/access/users/${login.id}`)
        : await call("PATCH", `/api/access/users/${login.id}`, action === "reset" ? { resetPassword: true } : { disabled: !login.disabled });
    setBusy(null);
    if (!res.ok) return setError(errorOf(res.data));
    if (action === "reset") return setRevealed({ email: login.email, password: String(res.data.password) });
    window.location.reload();
  }

  // Right after creating the login: show the password, then a way back.
  if (!login && revealed) {
    return (
      <div>
        <PasswordReveal
          email={revealed.email}
          password={revealed.password}
          note="Send it to the client with the portal's address. You can reset it here any time."
        />
        <button type="button" onClick={() => window.location.reload()} className={`mt-4 ${BTN_PRIMARY}`}>
          Done
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={login ? save : create}>
      {client.archived && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {client.name} is archived, so this login can&apos;t sign in until the client is restored.
        </div>
      )}
      <div className="max-w-sm">
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Login email
          <input
            type="email"
            required
            aria-describedby="login-email-hint"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="marketing@client.com"
            className={`mt-1 ${INPUT}`}
          />
        </label>
        <p id="login-email-hint" className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          One shared login for everyone at {client.name}.
        </p>
      </div>

      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Tabs they can see</legend>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Settings is never shown to a client, and on the tabs they see, every button that runs something is hidden.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {tabs.map((t) => (
            <label
              key={t.segment}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
            >
              <span className="text-zinc-800 dark:text-zinc-200">{t.label}</span>
              <input
                type="checkbox"
                role="switch"
                checked={chosen.has(t.segment)}
                onChange={() => toggle(t.segment)}
                className="h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
              />
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {login ? (
          <button type="submit" disabled={busy !== null || !changed} className={BTN_PRIMARY}>
            {busy === "save" ? "Saving…" : "Save changes"}
          </button>
        ) : (
          <button type="submit" disabled={busy !== null || !email.trim()} className={BTN_PRIMARY}>
            {busy === "create" ? "Creating…" : "Create login"}
          </button>
        )}
        {!login && <span className="text-xs text-zinc-500 dark:text-zinc-400">A password is generated for you to send them.</span>}
      </div>

      {login && (
        <div className="mt-6 border-t border-zinc-100 pt-5 dark:border-zinc-900">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {login.disabled ? "Turned off. " : ""}Last signed in: <LocalTime iso={login.lastLoginAt} />
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy !== null} onClick={() => act("reset")} className={BTN_SECONDARY}>
              {busy === "reset" ? "Resetting…" : "Reset password"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => act("toggle")} className={BTN_SECONDARY}>
              {login.disabled ? "Turn login on" : "Turn login off"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => act("remove")} className={BTN_DANGER}>
              Remove login
            </button>
          </div>
          {revealed && (
            <PasswordReveal
              email={revealed.email}
              password={revealed.password}
              note="The old password stopped working, and anyone signed in with it was signed out."
            />
          )}
        </div>
      )}

      {error && <div className={ERROR}>{error}</div>}
    </form>
  );
}
