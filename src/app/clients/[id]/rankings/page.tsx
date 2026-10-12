import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ModelFilter } from "@/components/model-filter";
import { DateRangePicker } from "@/components/date-range-picker";
import { VisibilityTrendChart, type TrendPoint } from "@/components/visibility-trend-chart";
import { PLATFORM_LABEL, CATEGORY_LABEL } from "@/lib/geo-platform-map";
import { parseISODate, resolveComparisonRange, type CompareMode, type DateRange } from "@/lib/date-range";

export const dynamic = "force-dynamic";

async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      domain: true,
      runs: {
        orderBy: { startedAt: "asc" },
        include: {
          promptSet: true,
          rawResponses: {
            include: {
              prompt: true,
              parsedResult: { include: { mentions: { include: { brand: true } } } },
            },
          },
        },
      },
      benchmarkSnapshots: {
        orderBy: { snapshotDate: "asc" },
        include: { competitors: { orderBy: { visibilityPct: "desc" } }, prompts: true },
      },
    },
  });
}

type ClientData = NonNullable<Awaited<ReturnType<typeof getClient>>>;
type RunData = ClientData["runs"][number];
type RawResponseData = RunData["rawResponses"][number];

interface BrandRow {
  key: string;
  name: string;
  isClientBrand: boolean;
  appearances: number;
  avgPosition: number | null;
  visibilityPct: number;
  delta: number | null;
}

interface PromptRankRow {
  key: string;
  text: string;
  category: string | null;
  checks: number;
  mentioned: number;
  visibilityPct: number;
  avgRank: number | null;
}

function inWindow(run: RunData, range: DateRange | null): boolean {
  if (!range) return true;
  const endExclusive = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 1);
  return run.startedAt.getTime() >= range.start.getTime() && run.startedAt.getTime() < endExclusive.getTime();
}

function buildPromptRankings(
  primaryRuns: RunData[],
  matchesPlatform: (r: RawResponseData) => boolean,
): PromptRankRow[] {
  const acc = new Map<
    string,
    { text: string; category: string | null; checks: number; mentioned: number; ranks: number[] }
  >();
  for (const run of primaryRuns) {
    for (const r of run.rawResponses) {
      if (!matchesPlatform(r)) continue;
      const key = r.prompt.text.trim().toLowerCase();
      const mentioned = !!r.parsedResult?.clientBrandMentioned;
      const rank = r.parsedResult?.clientBrandRank;
      const existing = acc.get(key);
      if (existing) {
        existing.checks += 1;
        if (mentioned) {
          existing.mentioned += 1;
          if (rank != null) existing.ranks.push(rank);
        }
      } else {
        acc.set(key, {
          text: r.prompt.text,
          category: r.prompt.category,
          checks: 1,
          mentioned: mentioned ? 1 : 0,
          ranks: mentioned && rank != null ? [rank] : [],
        });
      }
    }
  }
  return Array.from(acc.entries())
    .map(([key, p]) => ({
      key,
      text: p.text,
      category: p.category,
      checks: p.checks,
      mentioned: p.mentioned,
      visibilityPct: p.checks ? (p.mentioned / p.checks) * 100 : 0,
      avgRank: p.ranks.length ? p.ranks.reduce((a, c) => a + c, 0) / p.ranks.length : null,
    }))
    .sort((a, b) => b.visibilityPct - a.visibilityPct);
}

function buildDashboardData(
  client: ClientData,
  platformFilter: string | undefined,
  dateRange: DateRange | null,
  comparisonRange: DateRange | null,
) {
  const completeRuns = client.runs.filter((r) => r.status === "COMPLETE");
  const matchesPlatform = (r: RawResponseData) => !platformFilter || r.platform === platformFilter;

  const platformsAvailable = Array.from(
    new Set(completeRuns.flatMap((run) => run.rawResponses.map((r) => r.platform))),
  ).sort();

  const primaryRuns = completeRuns.filter((run) => inWindow(run, dateRange));
  const comparisonRuns = comparisonRange ? completeRuns.filter((run) => inWindow(run, comparisonRange)) : [];

  const trendPoints: TrendPoint[] = [];
  for (const run of primaryRuns) {
    const matching = run.rawResponses.filter(matchesPlatform);
    if (matching.length === 0) continue;
    const mentioned = matching.filter((r) => r.parsedResult?.clientBrandMentioned).length;
    trendPoints.push({
      runId: run.id,
      dateLabel: run.startedAt.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: (mentioned / matching.length) * 100,
    });
  }

  const primaryMatching = primaryRuns.flatMap((run) => run.rawResponses.filter(matchesPlatform));
  const totalResponses = primaryMatching.length;
  const totalMentioned = primaryMatching.filter((r) => r.parsedResult?.clientBrandMentioned).length;
  const headlineVisibility = totalResponses ? (totalMentioned / totalResponses) * 100 : 0;

  const comparisonMatching = comparisonRuns.flatMap((run) => run.rawResponses.filter(matchesPlatform));
  const comparisonTotal = comparisonMatching.length;
  const comparisonMentioned = comparisonMatching.filter((r) => r.parsedResult?.clientBrandMentioned).length;
  const comparisonHeadlineVisibility = comparisonTotal ? (comparisonMentioned / comparisonTotal) * 100 : null;

  const brandAcc = new Map<
    string,
    { name: string; isClientBrand: boolean; appearances: number; positions: number[]; comparisonCount: number }
  >();

  function tally(responses: RawResponseData[], countsTowardAppearances: boolean) {
    for (const r of responses) {
      for (const m of r.parsedResult?.mentions ?? []) {
        const key = m.brand?.id ?? `raw:${m.rawLabel.toLowerCase()}`;
        const existing = brandAcc.get(key);
        const name = m.brand?.name ?? m.rawLabel;
        const isClientBrand = m.brand?.isClientBrand ?? false;
        if (existing) {
          if (countsTowardAppearances) {
            existing.appearances += 1;
            if (m.position != null) existing.positions.push(m.position);
          } else {
            existing.comparisonCount += 1;
          }
        } else {
          brandAcc.set(key, {
            name,
            isClientBrand,
            appearances: countsTowardAppearances ? 1 : 0,
            positions: countsTowardAppearances && m.position != null ? [m.position] : [],
            comparisonCount: countsTowardAppearances ? 0 : 1,
          });
        }
      }
    }
  }
  tally(primaryMatching, true);
  if (comparisonRange) tally(comparisonMatching, false);

  const hasComparison = !!comparisonRange && comparisonTotal > 0;

  const brandTable: BrandRow[] = Array.from(brandAcc.entries())
    .filter(([, b]) => b.appearances > 0)
    .map(([key, b]) => {
      const visibilityPct = totalResponses ? (b.appearances / totalResponses) * 100 : 0;
      let delta: number | null = null;
      if (hasComparison) {
        const comparisonPct = (b.comparisonCount / comparisonTotal) * 100;
        delta = visibilityPct - comparisonPct;
      }
      return {
        key,
        name: b.name,
        isClientBrand: b.isClientBrand,
        appearances: b.appearances,
        avgPosition: b.positions.length
          ? b.positions.reduce((a, c) => a + c, 0) / b.positions.length
          : null,
        visibilityPct,
        delta,
      };
    })
    .sort((a, b) => b.appearances - a.appearances);

  const promptRankings = buildPromptRankings(primaryRuns, matchesPlatform);

  return {
    platformsAvailable,
    trendPoints,
    headlineVisibility,
    comparisonHeadlineVisibility,
    hasComparison,
    totalResponses,
    brandTable,
    promptRankings,
  };
}

export default async function ClientRankingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const model = sp.model;
  const platformFilter = typeof model === "string" && model ? model : undefined;

  const startParam = typeof sp.start === "string" ? sp.start : undefined;
  const endParam = typeof sp.end === "string" ? sp.end : undefined;
  const dateRange: DateRange | null =
    startParam && endParam ? { start: parseISODate(startParam), end: parseISODate(endParam) } : null;

  const compareMode = (typeof sp.compare === "string" ? sp.compare : "none") as CompareMode;
  const compareStartParam = typeof sp.compareStart === "string" ? sp.compareStart : undefined;
  const compareEndParam = typeof sp.compareEnd === "string" ? sp.compareEnd : undefined;
  const customCompareRange: DateRange | null =
    compareStartParam && compareEndParam
      ? { start: parseISODate(compareStartParam), end: parseISODate(compareEndParam) }
      : null;
  const comparisonRange = resolveComparisonRange(dateRange, compareMode, customCompareRange);

  const client = await getClient(id);
  if (!client) notFound();

  const {
    platformsAvailable,
    trendPoints,
    headlineVisibility,
    comparisonHeadlineVisibility,
    hasComparison,
    totalResponses,
    brandTable,
    promptRankings,
  } = buildDashboardData(client, platformFilter, dateRange, comparisonRange);

  const scoreDelta =
    hasComparison && comparisonHeadlineVisibility != null ? headlineVisibility - comparisonHeadlineVisibility : null;

  const promptGroups = new Map<string, PromptRankRow[]>();
  for (const p of promptRankings) {
    const list = promptGroups.get(p.category ?? "uncategorized") ?? [];
    list.push(p);
    promptGroups.set(p.category ?? "uncategorized", list);
  }

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}</h1>
          {client.domain && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <ModelFilter platforms={platformsAvailable.map((p) => ({ key: p, label: PLATFORM_LABEL[p] ?? p }))} />
          <DateRangePicker />
        </div>
      </header>

      <section className="mb-8">
        <div className="mb-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Visibility Score
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <div className="text-3xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
              {headlineVisibility.toFixed(1)}%
            </div>
            {scoreDelta != null && (
              <span
                className={`text-sm font-medium tabular-nums ${
                  scoreDelta > 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : scoreDelta < 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-zinc-400 dark:text-zinc-600"
                }`}
              >
                {scoreDelta > 0 ? "▲" : scoreDelta < 0 ? "▼" : "–"} {Math.abs(scoreDelta).toFixed(1)}pp vs.{" "}
                {comparisonHeadlineVisibility!.toFixed(1)}%
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            across {totalResponses} check{totalResponses === 1 ? "" : "s"}
            {platformFilter ? ` · ${PLATFORM_LABEL[platformFilter] ?? platformFilter} only` : ""}
          </div>
        </div>
        <VisibilityTrendChart points={trendPoints} />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Prompt Rankings
        </h2>
        {promptRankings.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            No completed runs in this range{platformFilter ? " for this platform" : ""}.
          </div>
        ) : (
          <div className="space-y-6">
            {Array.from(promptGroups.entries()).map(([category, prompts]) => (
              <div key={category}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  {CATEGORY_LABEL[category] ?? category}
                </h3>
                <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                      <tr>
                        <th className="px-4 py-2 font-medium">Prompt</th>
                        <th className="px-4 py-2 font-medium tabular-nums">Visibility</th>
                        <th className="px-4 py-2 font-medium tabular-nums">Avg Rank</th>
                        <th className="px-4 py-2 font-medium tabular-nums">Checks</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                      {prompts.map((p) => (
                        <tr key={p.key} className="bg-white dark:bg-zinc-950">
                          <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{p.text}</td>
                          <td className="px-4 py-2 tabular-nums">{p.visibilityPct.toFixed(0)}%</td>
                          <td className="px-4 py-2 tabular-nums">{p.avgRank != null ? p.avgRank.toFixed(1) : "—"}</td>
                          <td className="px-4 py-2 tabular-nums">{p.checks}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Competitors
        </h2>
        {brandTable.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            No completed runs in this range{platformFilter ? " for this platform" : ""}.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Rank</th>
                  <th className="px-4 py-2 font-medium">Brand</th>
                  <th className="px-4 py-2 font-medium tabular-nums">Position</th>
                  <th className="px-4 py-2 font-medium tabular-nums">Visibility</th>
                  <th className="px-4 py-2 font-medium tabular-nums">Share of Voice</th>
                  {hasComparison && <th className="px-4 py-2 font-medium tabular-nums">Change</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {brandTable.slice(0, 15).map((b, i) => {
                  const totalAppearances = brandTable.reduce((a, c) => a + c.appearances, 0);
                  const sov = totalAppearances ? (b.appearances / totalAppearances) * 100 : 0;
                  return (
                    <tr key={b.key} className={b.isClientBrand ? "bg-blue-50 dark:bg-blue-950/40" : "bg-white dark:bg-zinc-950"}>
                      <td className="px-4 py-3 tabular-nums text-zinc-500 dark:text-zinc-400">#{i + 1}</td>
                      <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                        {b.name}
                        {b.isClientBrand && (
                          <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                            You
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums">{b.avgPosition != null ? b.avgPosition.toFixed(1) : "—"}</td>
                      <td className="px-4 py-3 tabular-nums">{b.visibilityPct.toFixed(1)}%</td>
                      <td className="px-4 py-3 tabular-nums">{sov.toFixed(1)}%</td>
                      {hasComparison && (
                        <td className="px-4 py-3 tabular-nums">
                          {b.delta == null ? (
                            <span className="text-zinc-400 dark:text-zinc-600">—</span>
                          ) : (
                            <span
                              className={
                                b.delta > 0
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : b.delta < 0
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-zinc-400 dark:text-zinc-600"
                              }
                            >
                              {b.delta > 0 ? "▲" : b.delta < 0 ? "▼" : "–"} {Math.abs(b.delta).toFixed(1)}pp
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Competitors are detected automatically from run results. Manage the tracked list in{" "}
          <a href={`/clients/${id}/competitors`} className="underline">
            Competitors
          </a>
          .
        </p>
      </section>

      {client.benchmarkSnapshots.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Historical Benchmark
          </h2>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            Imported from a prior report, not from a tracked run — a reference point, not additional live data.
          </p>
          <div className="space-y-6">
            {client.benchmarkSnapshots.map((snap) => (
              <div
                key={snap.id}
                className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-900/40"
              >
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {snap.source} benchmark — {snap.snapshotDate.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      timeZone: "UTC", // snapshotDate is stored as a UTC-midnight date-only value; without
                      // pinning the display timezone, a browser/server behind UTC renders the day before.
                    })}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                    {snap.ownVisibilityPct != null && <span>Visibility: {snap.ownVisibilityPct}%</span>}
                    {snap.ownPosition != null && <span>Position: {snap.ownPosition}</span>}
                    {snap.ownSentiment != null && <span>Sentiment: {snap.ownSentiment}/100</span>}
                  </div>
                </div>

                {snap.prompts.length > 0 && (
                  <div className="mb-4 overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                        <tr>
                          <th className="px-3 py-1.5 font-medium">Prompt</th>
                          <th className="px-3 py-1.5 font-medium tabular-nums">Position</th>
                          <th className="px-3 py-1.5 font-medium tabular-nums">Sentiment</th>
                          <th className="px-3 py-1.5 font-medium tabular-nums">Visibility</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                        {snap.prompts.map((p) => (
                          <tr key={p.id} className="bg-white dark:bg-zinc-950">
                            <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{p.promptText}</td>
                            <td className="px-3 py-1.5 tabular-nums">{p.position ?? "—"}</td>
                            <td className="px-3 py-1.5 tabular-nums">{p.sentiment ?? "—"}</td>
                            <td className="px-3 py-1.5 tabular-nums">
                              {p.visibilityPct != null ? `${p.visibilityPct}%` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {snap.competitors.length > 0 && (
                  <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                        <tr>
                          <th className="px-3 py-1.5 font-medium">Brand</th>
                          <th className="px-3 py-1.5 font-medium tabular-nums">Position</th>
                          <th className="px-3 py-1.5 font-medium tabular-nums">Visibility</th>
                          <th className="px-3 py-1.5 font-medium tabular-nums">Sentiment</th>
                          <th className="px-3 py-1.5 font-medium tabular-nums">Share of Voice</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                        {snap.competitors.map((c) => (
                          <tr key={c.id} className="bg-white dark:bg-zinc-950">
                            <td className="px-3 py-1.5 font-medium text-zinc-900 dark:text-zinc-100">{c.name}</td>
                            <td className="px-3 py-1.5 tabular-nums">{c.position ?? "—"}</td>
                            <td className="px-3 py-1.5 tabular-nums">
                              {c.visibilityPct != null ? `${c.visibilityPct}%` : "—"}
                            </td>
                            <td className="px-3 py-1.5 tabular-nums">{c.sentiment ?? "—"}</td>
                            <td className="px-3 py-1.5 tabular-nums">
                              {c.shareOfVoicePct != null ? `${c.shareOfVoicePct}%` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {snap.sourceNote && (
                  <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-600">{snap.sourceNote}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
