"use client";

import { useState } from "react";

export function RunNowButton({ clientId }: { clientId: string }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/run`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "The run failed. Check Vercel logs for details.");
        setRunning(false);
        return;
      }
      // Full navigation, not router.push -- same documented workaround as
      // client-switcher.tsx for this project's next/navigation commit bug.
      window.location.href = `/runs/${data.runId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleRun}
          disabled={running}
          className="inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {running ? "Running…" : "Run Now"}
        </button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Re-runs this client's existing tracked prompts immediately.
        </span>
      </div>

      {running && (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300">
          Running the prompts across all tracked platforms… this usually takes 1-3 minutes.
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
