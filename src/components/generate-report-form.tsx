"use client";

import { useState } from "react";
import { ReportRangePicker, type DayRange } from "@/components/report-range-picker";
import { periodError, previousPeriod, type CompareSpec } from "@/lib/report-period";

export interface CompareOption {
  value: string; // "benchmark:<snapshotId>" | "firstCrawl" | "previous" | "custom"
  label: string;
}

function toSpec(value: string, custom: DayRange | null): CompareSpec | null {
  if (value.startsWith("benchmark:")) return { kind: "benchmark", snapshotId: value.slice("benchmark:".length) };
  if (value === "firstCrawl" || value === "previous") return { kind: value };
  if (value === "custom" && custom) return { kind: "custom", start: custom.start, end: custom.end };
  return null;
}

const overlaps = (a: DayRange, b: DayRange) => a.start <= b.end && b.start <= a.end;

export function GenerateReportForm({
  clientId,
  presets,
  defaultPeriod,
  compareOptions,
  defaultCompare,
  firstCrawlDays,
  savedPeriods,
}: {
  clientId: string;
  presets: { key: string; label: string; period: DayRange }[];
  defaultPeriod: DayRange;
  compareOptions: CompareOption[];
  defaultCompare: string;
  firstCrawlDays: string[] | null;
  savedPeriods: DayRange[];
}) {
  const [period, setPeriod] = useState<DayRange>({ start: defaultPeriod.start, end: defaultPeriod.end });
  const [compare, setCompare] = useState(defaultCompare);
  const [custom, setCustom] = useState<DayRange | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exists = savedPeriods.some((p) => p.start === period.start && p.end === period.end);
  const previous = previousPeriod(period.start, period.end);
  const isBenchmark = compare.startsWith("benchmark:");

  let overlapNote: string | null = null;
  if (compare === "firstCrawl" && firstCrawlDays?.some((d) => d >= period.start && d <= period.end)) {
    overlapNote = "The first crawl falls inside this report period, so the report partly compares that crawl with itself.";
  } else if (compare === "custom" && custom && overlaps(custom, period)) {
    overlapNote = "The two periods overlap, so the report partly compares those days with themselves.";
  }

  async function handleGenerate() {
    setError(null);
    const bad = periodError(period.start, period.end);
    if (bad) return setError(bad);
    const spec = toSpec(compare, custom);
    if (!spec) return setError("Pick the days to compare with.");
    if (spec.kind === "custom") {
      const badCompare = periodError(spec.start, spec.end, "comparison period");
      if (badCompare) return setError(badCompare);
    }
    setGenerating(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: period.start, end: period.end, compare: spec }),
      });
      const data = await res.json().catch(() => ({ error: "No response in time -- refresh in a minute." }));
      if (!res.ok) {
        setError(data.detail ? `${data.error} ${data.detail}` : (data.error ?? "Generation failed."));
        setGenerating(false);
        return;
      }
      // Full navigation, not router.push -- router.push silently fails on this app's client routes.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- see the line above
      window.location.href = `/report/${data.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div>
          <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Report period</div>
          <ReportRangePicker label="Report period" value={period} onChange={setPeriod} presets={presets} disabled={generating} />
        </div>
        <div>
          <label htmlFor="report-compare" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Compare with
          </label>
          <select
            id="report-compare"
            value={compare}
            onChange={(e) => setCompare(e.target.value)}
            disabled={generating}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          >
            {compareOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value === "previous" ? `${o.label} (${previous.label})` : o.label}
              </option>
            ))}
          </select>
          {compare === "custom" && (
            <div className="mt-2">
              <ReportRangePicker label="Days to compare with" value={custom} onChange={setCustom} disabled={generating} />
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={generating}
        className="inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
      >
        {generating ? "Generating…" : exists ? "Regenerate report" : "Generate report"}
      </button>

      {overlapNote && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">{overlapNote}</p>
      )}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Uses this portal&apos;s runs, citations, Google Analytics, Search Console and AI crawler data. Takes about 20 seconds.
        {isBenchmark &&
          " An imported benchmark has overall visibility and rank, prompt ranks and its own competitor list, so the per-platform and citation sections show the report period alone."}
        {(isBenchmark || compare === "firstCrawl") &&
          ` Traffic is compared with the same number of days up to the ${isBenchmark ? "benchmark" : "first crawl"}.`}
        {exists ? " A report for these days is already saved: regenerating replaces it, including its written takeaways, and keeps its link." : ""}
      </p>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
