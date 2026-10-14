"use client";

import { useState } from "react";

type Mode = "live" | "training";

export function RunNowButton({ clientId }: { clientId: string }) {
  const [running, setRunning] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRun(mode: Mode) {
    setError(null);
    setRunning(mode);
    try {
      const res = await fetch(`/api/clients/${clientId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveSearch: mode === "live" }),
      });
      // A platform-level timeout kills the function before it ever returns
      // JSON (a plain-text/HTML error body instead), which throws here --
      // confirmed live on a real Live Search run that ran past the (then)
      // 300s limit, now 800s on the Pro plan. Give a
      // clear message instead of surfacing the raw "JSON.parse: unexpected
      // character" browser error.
      let data: { runId?: string; error?: string };
      try {
        data = await res.json();
      } catch {
        setError(
          "The run didn't respond in time (it may still be running server-side). Refresh Run History below in a " +
            "few minutes before trying again.",
        );
        setRunning(null);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "The run failed. Check Vercel logs for details.");
        setRunning(null);
        return;
      }
      // Full navigation, not router.push -- same documented workaround as
      // client-switcher.tsx for this project's next/navigation commit bug.
      window.location.href = `/runs/${data.runId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => handleRun("live")}
          disabled={running !== null}
          className="inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {running === "live" ? "Running…" : "Live Search"}
        </button>
        <button
          type="button"
          onClick={() => handleRun("training")}
          disabled={running !== null}
          className="inline-flex items-center rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {running === "training" ? "Running…" : "Training Search"}
        </button>
      </div>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Both re-run this client&apos;s existing tracked prompts immediately. <strong>Live Search</strong> makes each
        platform do a real web search before answering, reflecting current results. <strong>Training Search</strong>{" "}
        answers from each model&apos;s training data only, with no web access -- faster and cheaper, but can be
        stale.
      </p>

      {running && (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300">
          Running the prompts across all tracked platforms{running === "live" ? " with live web search" : ""}… this
          usually takes {running === "live" ? "3-10" : "1-3"} minutes.
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
