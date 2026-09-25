import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StatusPill } from "@/components/status-pill";
import { ModelFilter } from "@/components/model-filter";
import { DateRangePicker } from "@/components/date-range-picker";
import { VisibilityTrendChart, type TrendPoint } from "@/components/visibility-trend-chart";
import { PLATFORM_LABEL } from "@/lib/geo-platform-map";
import { parseISODate, resolveComparisonRange, type CompareMode, type DateRange } from "@/lib/date-range";

export const dynamic = "force-dynamic";

async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    include: {
      brands: { orderBy: [{ isClientBrand: "desc" }, { name: "asc" }] },
      runs: {
        orderBy: { startedAt: "asc" },
        include: {
          promptSet: true,
          _count: { select: { rawResponses: true } },
          rawResponses: {
            include: { parsedResult: { include: { mentions: { include: { brand: true } } } } },
          },
        },
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
  delta: number | null; // percentage points vs. the comparison period, null if no comparison active
}

function inWindow(run: RunData, range: DateRange | null): boolean {
  if (!range) return true;
  const endExclusive = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 1);
  return run.startedAt.getTime() >= range.start.getTime() && run.startedAt.getTime() < endExclusive.getTime();
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

  // Trend chart: one point per primary-window run with matching responses --
  // a run with zero matching responses is skipped rather than plotted as a
  // fake 0% dip.
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

  return {
    platformsAvailable,
    trendPoints,
    headlineVisibility,
    comparisonHeadlineVisibility,
    hasComparison,
    totalResponses,
    brandTable,
  };
}

export default async function ClientDetailPage({
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
  } = buildDashboardData(client, platformFilter, dateRange, comparisonRange);

  const scoreDelta = hasComparison && comparisonHeadlineVisibility != null ? headlineVisibility - comparisonHeadlineVisibility : null;

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Link
          href="/clients"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          ← All clients
        </Link>

        <header className="mt-1 mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
              {client.name}
            </h1>
            {client.domain && (
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <ModelFilter
              platforms={platformsAvailable.map((p) => ({ key: p, label: PLATFORM_LABEL[p] ?? p }))}
            />
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
            Competitor Ranking
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
                      <tr
                        key={b.key}
                        className={
                          b.isClientBrand
                            ? "bg-blue-50 dark:bg-blue-950/40"
                            : "bg-white dark:bg-zinc-950"
                        }
                      >
                        <td className="px-4 py-3 tabular-nums text-zinc-500 dark:text-zinc-400">
                          #{i + 1}
                        </td>
                        <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                          {b.name}
                          {b.isClientBrand && (
                            <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                              You
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {b.avgPosition != null ? b.avgPosition.toFixed(1) : "—"}
                        </td>
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
        </section>

        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Schedule &amp; Analytics
          </h2>
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <span className="text-zinc-500 dark:text-zinc-400">Schedule: </span>
                <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  {client.schedule}
                </span>
              </div>
              <div>
                <span className="text-zinc-500 dark:text-zinc-400">GA4 Property: </span>
                <span className="text-zinc-900 dark:text-zinc-100">
                  {client.ga4PropertyId || "Not set"}
                </span>
              </div>
              <div>
                <span className="text-zinc-500 dark:text-zinc-400">GSC Site: </span>
                <span className="text-zinc-900 dark:text-zinc-100">
                  {client.gscSiteUrl || "Not set"}
                </span>
              </div>
            </div>
            <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-600">
              Captured for future automation — no recurring runs are triggered automatically yet.
            </p>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Run History
          </h2>
          {client.runs.length === 0 ? (
            <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
              No runs yet for this client.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">Started</th>
                    <th className="px-4 py-2 font-medium">Prompt Set</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium tabular-nums">Responses</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                  {[...client.runs].reverse().map((run) => (
                    <tr key={run.id} className="bg-white dark:bg-zinc-950">
                      <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                        {run.startedAt.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                        {run.promptSet.label}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill status={run.status} />
                      </td>
                      <td className="px-4 py-3 tabular-nums">{run._count.rawResponses}</td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/runs/${run.id}`}
                          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          View results →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
