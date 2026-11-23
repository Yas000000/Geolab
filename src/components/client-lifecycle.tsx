"use client";

import { useState } from "react";

const BTN_PRIMARY =
  "inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";
const BTN_SECONDARY =
  "inline-flex items-center rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900";
const BTN_DANGER =
  "inline-flex items-center rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600";
const ERROR_BOX =
  "mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300";

/** A date in the viewer's own timezone (the server renders in UTC, which can be a day off). */
export function LocalDay({ iso }: { iso: string }) {
  return (
    <span suppressHydrationWarning>
      {new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
    </span>
  );
}

async function patchArchived(clientId: string, archived: boolean): Promise<string | null> {
  try {
    const res = await fetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return data.error ?? `That didn't work (error ${res.status}).`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** One-click restore, used on the archived banner and in the client list's archived section. */
export function RestoreButton({ clientId, small = false }: { clientId: string; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    const err = await patchArchived(clientId, false);
    if (err) {
      setError(err);
      setBusy(false);
      return;
    }
    // Full reload, not router.refresh/push: this project's documented next/navigation workaround.
    window.location.reload();
  }

  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        onClick={restore}
        disabled={busy}
        className={small ? `${BTN_SECONDARY} px-3 py-1 text-xs` : BTN_SECONDARY}
      >
        {busy ? "Restoring…" : "Restore"}
      </button>
      {error && <span className="mt-1 text-xs text-red-700 dark:text-red-400">{error}</span>}
    </span>
  );
}

/** Shown above every tab of an archived client. */
export function ArchivedBanner({ clientId, name, archivedAt }: { clientId: string; name: string; archivedAt: string }) {
  return (
    <div className="mb-6 flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <p>
        <strong>{name} is archived</strong> (since <LocalDay iso={archivedAt} />). All its data is still here, but
        scheduled runs, AI crawler checks and Google data pulls are off, and nothing new can be run until you restore
        it.
      </p>
      <div className="shrink-0">
        <RestoreButton clientId={clientId} />
      </div>
    </div>
  );
}

/** Settings > Archive or Delete. */
export function ClientLifecyclePanel({
  clientId,
  name,
  archivedAt,
  runCount,
  answerCount,
}: {
  clientId: string;
  name: string;
  archivedAt: string | null;
  runCount: number;
  answerCount: number;
}) {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameMatches = typed.trim().toLowerCase() === name.trim().toLowerCase();
  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  const history =
    runCount > 0 ? `${plural(runCount, "run")} with ${plural(answerCount, "answer")}` : "its setup (no runs yet)";

  async function archive() {
    setArchiving(true);
    setError(null);
    const err = await patchArchived(clientId, true);
    if (err) {
      setError(err);
      setArchiving(false);
      return;
    }
    window.location.reload();
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: typed }),
      });
      if (res.ok) {
        // Full navigation, not router.push: same documented workaround as client-switcher.tsx.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = "/clients";
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? `The delete didn't go through (error ${res.status}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setDeleting(false);
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Archive</h3>
        {archivedAt ? (
          <>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Archived on <LocalDay iso={archivedAt} />. Restoring puts {name} back in the client list and turns its
              schedule back on.
            </p>
            <div className="mt-3">
              <RestoreButton clientId={clientId} />
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Hides {name} from the client list and stops its scheduled runs, AI crawler checks and Google data pulls.
              Nothing is deleted, and you can restore it any time with its full history.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {confirmArchive ? (
                <>
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">Archive {name}?</span>
                  <button type="button" onClick={archive} disabled={archiving} className={BTN_PRIMARY}>
                    {archiving ? "Archiving…" : "Archive"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmArchive(false)}
                    disabled={archiving}
                    className={BTN_SECONDARY}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmArchive(true)} className={BTN_SECONDARY}>
                  Archive client
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="border-t border-zinc-100 pt-5 dark:border-zinc-900">
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Delete</h3>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Permanently deletes {name} and everything under it: {history}, plus its citations, rankings, reports,
          outreach plans and Google data. This can&apos;t be undone.
        </p>
        {deleteOpen ? (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-4 dark:border-red-900 dark:bg-red-950/40">
            <label className="block text-sm text-red-900 dark:text-red-200">
              Type <strong>{name}</strong> to confirm
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mt-2 block w-full max-w-sm rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-red-500 focus:outline-none dark:border-red-800 dark:bg-zinc-950 dark:text-zinc-100"
              />
            </label>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" onClick={remove} disabled={!nameMatches || deleting} className={BTN_DANGER}>
                {deleting ? "Deleting…" : `Delete ${name} forever`}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteOpen(false);
                  setTyped("");
                  setError(null);
                }}
                disabled={deleting}
                className={BTN_SECONDARY}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="inline-flex items-center rounded-full border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-zinc-950 dark:text-red-400 dark:hover:bg-red-950"
            >
              Delete client…
            </button>
          </div>
        )}
      </div>

      {error && <div className={ERROR_BOX}>{error}</div>}
    </div>
  );
}
