"use client";

import { useState } from "react";

export function GenerateReportForm({
  clientId,
  months,
  defaultMonth,
  existingMonths,
}: {
  clientId: string;
  months: { value: string; label: string }[];
  defaultMonth: string;
  existingMonths: string[];
}) {
  const [month, setMonth] = useState(defaultMonth);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exists = existingMonths.includes(month);

  async function handleGenerate() {
    setError(null);
    setGenerating(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const data = await res.json().catch(() => ({ error: "No response in time -- refresh in a minute." }));
      if (!res.ok) {
        setError(data.detail ? `${data.error} ${data.detail}` : (data.error ?? "Generation failed."));
        setGenerating(false);
        return;
      }
      // Full navigation, not router.push -- router.push silently fails on this app's client routes.
      window.location.href = `/report/${data.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          disabled={generating}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        >
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating}
          className="inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {generating ? "Generating…" : exists ? "Regenerate report" : "Generate report"}
        </button>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Compares the month against the month before, using this portal&apos;s runs, citations, Google Analytics,
        Search Console and AI crawler data. Takes about 20 seconds.
        {exists ? " Regenerating replaces the saved report for this month, including its written takeaways." : ""}
      </p>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
