"use client";

import { useEffect, useState } from "react";

type Progress = { step: string; done?: number; total?: number } | null;

// Estimates, so no false precision: "about $9.40", or "under $1" for small amounts.
const about = (n: number) => (n < 1 ? "under $1" : `about $${n.toFixed(2)}`);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function progressText(p: Progress): string {
  if (!p) return "Starting…";
  return p.total != null ? `${p.step}: ${p.done ?? 0} of ${p.total}` : `${p.step}…`;
}

/**
 * Build / Rebuild button for the Outreach Plan tab. Nothing runs until the cost shown here is
 * confirmed: a build researches sites with paid web search. While a build runs, it polls the
 * build's status and reloads the page when it finishes.
 */
export function OutreachBuildPanel({
  clientId,
  label,
  running,
  initialProgress,
  targets,
  sitesToResearch,
  promptCount,
  estimatesReused,
  researchCost,
  estimateCost,
  pageCheckCost,
  costEstimate,
  disabledReason,
}: {
  clientId: string;
  label: string;
  running: boolean;
  initialProgress: Progress;
  targets: number;
  sitesToResearch: number;
  promptCount: number;
  estimatesReused: boolean;
  researchCost: number;
  estimateCost: number;
  pageCheckCost: number;
  costEstimate: number;
  disabledReason: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [polling, setPolling] = useState(running);
  const [progress, setProgress] = useState<Progress>(initialProgress);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/clients/${clientId}/outreach`, { cache: "no-store" });
        const data = (await res.json()) as { status: string; progress: Progress } | null;
        if (!data) return;
        if (data.status === "RUNNING") setProgress(data.progress);
        else window.location.reload(); // finished or failed: the page shows the result
      } catch {
        // a missed poll is fine; the next one catches up
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [polling, clientId]);

  async function start() {
    setError(null);
    setStarting(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/outreach`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "The build couldn't start.");
        setStarting(false);
        return;
      }
      setConfirming(false);
      setProgress({ step: "Starting" });
      setPolling(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setStarting(false);
  }

  if (polling) {
    return (
      <div className="flex items-center gap-3 text-sm text-zinc-700 dark:text-zinc-300">
        <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500" aria-hidden />
        <span>
          Building: {progressText(progress)}. This takes about 5 to 10 minutes; you can leave the page and come back.
        </span>
      </div>
    );
  }

  const parts = [
    sitesToResearch
      ? `researches ${sitesToResearch} of the ${targets} most-cited sites with web search (${about(researchCost)})`
      : `reuses the saved research for all ${targets} sites`,
    estimatesReused
      ? "reuses the saved action estimates where nothing changed"
      : `estimates the actions for ${promptCount} prompts (${about(estimateCost)})`,
    pageCheckCost
      ? `checks every cited page for your listing, using Google's copy of pages that block the server (${about(pageCheckCost)})`
      : "checks every cited page for your listing (free)",
  ];

  return (
    <div className="space-y-3">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={!!disabledReason}
          className="inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {label}
        </button>
      ) : (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p>
            This {parts.slice(0, -1).join(", ")} and {parts[parts.length - 1]}.{" "}
            <strong>{capitalize(about(costEstimate))} in total.</strong>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={start}
              disabled={starting}
              className="inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              {starting ? "Starting…" : `Build it (${about(costEstimate)})`}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={starting}
              className="inline-flex items-center rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {disabledReason && <p className="text-xs text-zinc-500 dark:text-zinc-400">{disabledReason}</p>}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
