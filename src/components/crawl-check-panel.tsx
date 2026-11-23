"use client";

import { useState } from "react";

export interface CrawlCheckRow {
  vendor: string;
  label: string;
  method: string;
  success: boolean;
  detail: string;
}

export function CrawlCheckPanel({
  clientId,
  url,
  checkedAtLabel,
  rows,
  scheduleNote,
}: {
  clientId: string;
  url: string | null;
  checkedAtLabel: string | null; // formatted server-side, so the browser's timezone can't shift it during hydration
  rows: CrawlCheckRow[];
  scheduleNote: string;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCheck() {
    setError(null);
    setChecking(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/crawl-check`, { method: "POST" });
      const data = await res.json().catch(() => ({ error: "The check didn't respond in time -- refresh in a minute." }));
      if (!res.ok) {
        setError(data.detail ? `${data.error} ${data.detail}` : (data.error ?? "Check failed."));
        setChecking(false);
        return;
      }
      // Full reload, not router.refresh -- same workaround as run-now-button.tsx.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setChecking(false);
    }
  }

  const blocked = rows.filter((r) => !r.success);

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Not checked yet. This asks Claude, Gemini and ChatGPT&apos;s own servers to reach{" "}
          {url ?? "the client's site"}. A site that blocks them can&apos;t be cited, however good its content is.
        </p>
      ) : (
        <>
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              blocked.length
                ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                : "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
            }`}
          >
            {blocked.length === 0
              ? `All three AI platforms reached ${url}.`
              : `${blocked.map((r) => r.label).join(" and ")} could not confirm access to ${url}. Check the details below before assuming a block: an API error or quota limit also shows here.`}
          </div>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Platform</th>
                  <th className="px-4 py-2 font-medium">Result</th>
                  <th className="px-4 py-2 font-medium">What it checked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {rows.map((r) => (
                  <tr key={r.vendor} className="bg-white align-top dark:bg-zinc-950">
                    <td className="px-4 py-2 font-medium text-zinc-900 dark:text-zinc-100">{r.label}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {r.success ? (
                        <span className="text-emerald-700 dark:text-emerald-400">Reached</span>
                      ) : (
                        <span className="text-red-700 dark:text-red-400">Not confirmed</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                      {r.method}
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-zinc-400 dark:text-zinc-500">Response</summary>
                        <div className="mt-1 text-xs break-words whitespace-pre-wrap text-zinc-500 dark:text-zinc-400">
                          {r.detail}
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleCheck}
          disabled={checking || !url}
          className="inline-flex items-center rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {checking ? "Checking…" : "Check now"}
        </button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {checkedAtLabel ? `Last checked ${checkedAtLabel}. ` : ""}
          {scheduleNote}
        </span>
      </div>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
