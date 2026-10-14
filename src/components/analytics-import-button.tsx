"use client";

import { useState } from "react";

export function AnalyticsImportButton({ clientId, coverage }: { clientId: string; coverage: string[] }) {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleImport() {
    setError(null);
    setImporting(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/analytics-import`, { method: "POST" });
      const data = await res.json().catch(() => ({ error: "The import didn't respond in time -- refresh in a minute." }));
      if (!res.ok) {
        setError(data.error ?? "Import failed.");
        setImporting(false);
        return;
      }
      // Full reload, not router.refresh -- same established workaround as
      // run-now-button.tsx for this project's next/navigation issues.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setImporting(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-zinc-600 dark:text-zinc-400">
        {coverage.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleImport}
          disabled={importing}
          className="inline-flex items-center rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {importing ? "Importing…" : "Import full history from Google"}
        </button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          All Google Analytics history, plus Search Console&apos;s last 16 months (its limit). Safe to re-run;
          existing days are updated, not duplicated.
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
