import { Fragment } from "react";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { competitorStats } from "@/lib/competitor-table";
import { ModelFilter } from "@/components/model-filter";
import { LocationFilter } from "@/components/location-filter";
import { DateRangePicker } from "@/components/date-range-picker";
import { VisibilityTrendChart, type TrendPoint } from "@/components/visibility-trend-chart";
import {
  CompetitorRankChart,
  type BrandCrawlPoint,
  type RankCrawl,
  type RankSeries,
} from "@/components/competitor-rank-chart";
import { PLATFORM_LABEL, CATEGORY_LABEL } from "@/lib/geo-platform-map";
import { benchmarkDateGroups } from "@/lib/benchmark-dates";
import { isLiveSearchModel } from "@/lib/citations";
import { geoAllTimeRange, parseISODate, resolveComparisonRange, type CompareMode, type DateRange } from "@/lib/date-range";
import { requireTab } from "@/lib/viewer";

export const dynamic = "force-dynamic";

async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      domain: true,
      locations: { orderBy: { position: "asc" } },
      runs: {
        orderBy: { startedAt: "asc" },
        include: {
          promptSet: true,
          rawResponses: {
            // Empty text = a failed call (e.g. Gemini's quota errors before
            // 2026-11-12), not an answer that left the client out -- counting
            // it would drag every visibility % down. Same rule as the
            // Citations page and the monthly report.
            where: { responseText: { not: "" } },
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

interface PlatformRankCell {
  avgRank: number | null;
  movement: number | null; // + = improved (moved up), - = dropped. null when there's nothing to compare.
  changeTitle: string | null; // hover text spelling out what the Change cell compares
  checks: number;
}

// What the Prompt Rankings Change columns compare. No "Compare To" picked:
// each prompt's most recent crawl vs. its first crawl in the date range.
// "periodEmpty": a Compare To period is picked but has no crawls in it.
type PromptChangeMode = "firstLatest" | "period" | "periodEmpty";

// Brands shown in the Competitors section's rank-by-crawl chart.
const RANK_CHART_BRANDS = 5;

// Prompt Rankings' first column: pinned while the platform columns scroll
// sideways, wide enough that a prompt isn't one word per line on a phone.
// From md up it's at least 16rem and takes whatever the (tight, no-wrap)
// number columns leave: pages are 96rem wide (src/lib/page-width.ts) so
// every column shows on load from a 1280px screen up.
// The divider is an inset shadow because a collapsed-table border doesn't
// travel with a sticky cell. Each cell still sets its own background.
const PROMPT_COL =
  "sticky left-0 z-[1] min-w-[11rem] md:min-w-[16rem] shadow-[inset_-1px_0_0_var(--color-zinc-200)] dark:shadow-[inset_-1px_0_0_var(--color-zinc-800)]";

// Failed calls (blank answers) are excluded in getClient's query, so every
// response here is a real answer and only those count as a crawl.
const crawlDay = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

// Other brands an answer names: its extracted Mention rows, minus the client's own.
function brandsNamed(r: RawResponseData): number {
  const keys = new Set<string>();
  for (const m of r.parsedResult?.mentions ?? []) {
    if (!m.brand?.isClientBrand) keys.add(m.brandId ?? m.rawLabel.trim().toLowerCase());
  }
  return keys.size;
}

interface PromptRankRow {
  key: string;
  text: string;
  category: string | null;
  checks: number;
  mentioned: number;
  visibilityPct: number;
  visibilityChange: number | null; // pp change vs. the comparison period, or latest vs. first crawl
  visibilityChangeTitle: string | null;
  top3Rate: number | null; // % of mentions (not of all checks) that ranked top-3
  shareOfVoicePct: number | null; // this prompt's client-brand mentions as a % of all brands' mentions on this prompt
  platforms: Record<string, PlatformRankCell>;
}

function inWindow(run: RunData, range: DateRange | null): boolean {
  if (!range) return true;
  const endExclusive = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 1);
  return run.startedAt.getTime() >= range.start.getTime() && run.startedAt.getTime() < endExclusive.getTime();
}

function inDateWindow(date: Date, range: DateRange | null): boolean {
  if (!range) return true;
  const endExclusive = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 1);
  return date.getTime() >= range.start.getTime() && date.getTime() < endExclusive.getTime();
}

type BenchmarkData = ClientData["benchmarkSnapshots"][number];

// Benchmark dates are UTC calendar days, so they're shown in UTC (a crawl's is a moment, shown locally).
const utcDay = (d: Date, withYear = false) =>
  d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
type BenchmarkRow = BenchmarkData["prompts"][number];
// A row can be measured on its own day (MacuMira's Claude rows: Oct 19, from the
// October report), else on the benchmark's date.
const rowDate = (s: BenchmarkData, row: BenchmarkRow) => row.measuredOn ?? s.snapshotDate;
// How a benchmark point reads in a Change hover: "Jun 1 (ISA benchmark)".
const benchmarkDay = (s: BenchmarkData, date: Date = s.snapshotDate) => `${utcDay(date)} (${s.source} benchmark)`;
// Rows measured on another day than `from` (the benchmark's date, or a prompt's
// earliest row): ["9 prompts Jun 1", "Claude Oct 19"] (src/lib/benchmark-dates.ts).
function otherDays(from: Date, rows: BenchmarkRow[], withYear = false): string[] {
  return benchmarkDateGroups(from, rows).map((g) =>
    g.platform
      ? `${PLATFORM_LABEL[g.platform] ?? g.platform} ${utcDay(g.date, withYear)}`
      : `${g.prompts} ${g.prompts === 1 ? "prompt" : "prompts"} ${utcDay(g.date, withYear)}`,
  );
}

// A benchmark with a prompt row per platform (MacuMira's) can start each
// platform's Change; one with combined rows only (Yellowbrick's ISA) can't,
// because one figure for every platform isn't any platform's rank (the user's
// call, 2026-11-18).
const perPlatformRows = (s: BenchmarkData) => s.prompts.filter((p) => p.platform != null);

// "A, B and C": house style, no Oxford comma.
const andList = (xs: string[]) => xs.reduce((acc, x, i) => (i === 0 ? x : `${acc}${i === xs.length - 1 ? " and " : ", "}${x}`), "");

// Per-platform columns, each with its own +/- Change. With a "Compare To"
// period picked in the date picker, Change is vs. that period -- the same
// mechanism driving the Competitors table's Change column. Without one, it
// is each prompt's most recent crawl vs. its first point in the range: the
// benchmark, for the platforms its prompt table covers (the benchmark is the
// start of tracking, so it comes first), else its first crawl.
function buildPromptRankings(
  primaryRuns: RunData[],
  comparisonRuns: RunData[],
  mode: PromptChangeMode,
  platforms: string[],
  benchmarks: BenchmarkData[],
): PromptRankRow[] {
  const hasComparison = mode === "period";
  interface CrawlPoint {
    runId: string; // a crawl's run id, or "benchmark:<id>"
    date: Date;
    label: string; // how it reads in the Change hover: "Nov 18", "Jun 1 (ISA benchmark)"
    rank: number | null; // null = the client isn't in this answer
    brandsNamed: number; // other brands this answer names
  }
  interface PlatformAcc {
    primaryRanks: number[];
    primaryChecks: number;
    comparisonRanks: number[];
    first: CrawlPoint | null;
    latest: CrawlPoint | null;
  }
  interface Acc {
    text: string;
    category: string | null;
    checks: number;
    mentioned: number;
    top3Count: number;
    totalMentionRows: number; // all brands' mentions on this prompt, for Share of Voice
    clientMentionRows: number;
    comparisonChecks: number;
    comparisonMentioned: number;
    byPlatform: Map<string, PlatformAcc>;
    // Answered checks per run (and per benchmark), for first-vs-latest Visibility Change.
    byRun: Map<string, { date: Date; label: string; checks: number; mentioned: number }>;
  }
  const acc = new Map<string, Acc>();

  function ensurePlatform(a: Acc, platform: string): PlatformAcc {
    let p = a.byPlatform.get(platform);
    if (!p) {
      p = { primaryRanks: [], primaryChecks: 0, comparisonRanks: [], first: null, latest: null };
      a.byPlatform.set(platform, p);
    }
    return p;
  }

  for (const run of primaryRuns) {
    for (const r of run.rawResponses) {
      const key = r.prompt.text.trim().toLowerCase();
      let a = acc.get(key);
      if (!a) {
        a = {
          text: r.prompt.text,
          category: r.prompt.category,
          checks: 0,
          mentioned: 0,
          top3Count: 0,
          totalMentionRows: 0,
          clientMentionRows: 0,
          comparisonChecks: 0,
          comparisonMentioned: 0,
          byPlatform: new Map(),
          byRun: new Map(),
        };
        acc.set(key, a);
      }
      a.checks += 1;
      const mentioned = !!r.parsedResult?.clientBrandMentioned;
      if (mentioned) a.mentioned += 1;
      const platformAcc = ensurePlatform(a, r.platform);
      platformAcc.primaryChecks += 1;
      if (mentioned) {
        const rank = r.parsedResult?.clientBrandRank;
        if (rank != null) {
          platformAcc.primaryRanks.push(rank);
          if (rank <= 3) a.top3Count += 1;
        }
      }
      const point: CrawlPoint = {
        runId: run.id,
        date: run.startedAt,
        label: crawlDay(run.startedAt),
        // Every mention has a rank: outside the AI's list it's #1 (parser
        // rule), and an answer that only cites the client's site is stored as
        // #1 too (run-persistence.ts).
        rank: mentioned ? (r.parsedResult?.clientBrandRank ?? 1) : null,
        brandsNamed: brandsNamed(r),
      };
      if (!platformAcc.first || point.date < platformAcc.first.date) platformAcc.first = point;
      if (!platformAcc.latest || point.date >= platformAcc.latest.date) platformAcc.latest = point;
      const v = a.byRun.get(run.id) ?? { date: run.startedAt, label: crawlDay(run.startedAt), checks: 0, mentioned: 0 };
      v.checks += 1;
      if (mentioned) v.mentioned += 1;
      a.byRun.set(run.id, v);
      for (const m of r.parsedResult?.mentions ?? []) {
        a.totalMentionRows += 1;
        if (m.brand?.isClientBrand) a.clientMentionRows += 1;
      }
    }
  }

  // A benchmark's per-platform rows start those platforms' Change (and the
  // prompt's Visibility Change) when it's earlier than the first crawl --
  // only for prompts tracked in this range, matched by the same text key.
  if (mode === "firstLatest") {
    const firstCrawl = Math.min(...primaryRuns.map((run) => run.startedAt.getTime()));
    for (const snap of benchmarks) {
      const rows = perPlatformRows(snap);
      if (!rows.length || snap.snapshotDate.getTime() >= firstCrawl) continue;
      const runId = `benchmark:${snap.id}`;
      const byPrompt = new Map<string, BenchmarkRow[]>();
      for (const row of rows) {
        const key = row.promptText.trim().toLowerCase();
        if (acc.has(key) && rowDate(snap, row).getTime() < firstCrawl) byPrompt.set(key, [...(byPrompt.get(key) ?? []), row]);
      }
      for (const [key, promptRows] of byPrompt) {
        const a = acc.get(key)!;
        // The prompt's Visibility Change starts at all its benchmark rows together, dated by
        // its earliest row ("May 12 (ISA benchmark; Claude Oct 19)").
        const earliest = new Date(Math.min(...promptRows.map((r) => rowDate(snap, r).getTime())));
        const others = otherDays(earliest, promptRows);
        const v = {
          date: earliest,
          label: `${utcDay(earliest)} (${snap.source} benchmark${others.length ? `; ${andList(others)}` : ""})`,
          checks: 0,
          mentioned: 0,
        };
        for (const row of promptRows) {
          const date = rowDate(snap, row);
          const point: CrawlPoint = {
            runId,
            date,
            label: benchmarkDay(snap, date),
            rank: row.position,
            brandsNamed: row.brandsNamed ?? 0,
          };
          const p = ensurePlatform(a, row.platform!);
          if (!p.first || point.date < p.first.date) p.first = point;
          v.checks += 1;
          if (row.position != null) v.mentioned += 1;
        }
        a.byRun.set(runId, v);
      }
    }
  }

  // Comparison-period ranks only matter for prompts already tracked in the
  // primary period -- a prompt that only existed in the comparison window
  // isn't "currently tracked," so it doesn't get a new row.
  if (hasComparison) {
    for (const run of comparisonRuns) {
      for (const r of run.rawResponses) {
        const key = r.prompt.text.trim().toLowerCase();
        const a = acc.get(key);
        if (!a) continue;
        a.comparisonChecks += 1;
        const mentioned = !!r.parsedResult?.clientBrandMentioned;
        if (mentioned) a.comparisonMentioned += 1;
        const rank = r.parsedResult?.clientBrandRank;
        if (mentioned && rank != null) ensurePlatform(a, r.platform).comparisonRanks.push(rank);
      }
    }
  }

  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, c) => a + c, 0) / arr.length : null);

  // Change is always a number (user's rules, 2026-11-13): an answer the
  // client isn't in counts as one place below the last brand it names, but
  // never better than one place below the client's rank in the other crawl,
  // so dropping out always reads as a drop and appearing as a gain. Without
  // that floor, an answer naming no brands would count a missing client as #1.
  // Missing from both answers: nothing moved, so no number.
  function firstLatestRankChange(p: PlatformAcc | undefined): Pick<PlatformRankCell, "movement" | "changeTitle"> {
    const f = p?.first;
    const l = p?.latest;
    if (!f || !l) return { movement: null, changeTitle: null };
    if (f.runId === l.runId) {
      return { movement: null, changeTitle: `Only one crawl with an answer so far (${l.label})` };
    }
    if (f.rank == null && l.rank == null) {
      return { movement: null, changeTitle: `Not in the answer on ${f.label} or ${l.label}` };
    }
    const counted = (pt: CrawlPoint, other: CrawlPoint) =>
      pt.rank ?? Math.max(pt.brandsNamed + 1, (other.rank ?? 0) + 1);
    const describe = (pt: CrawlPoint, other: CrawlPoint) =>
      pt.rank != null
        ? `#${pt.rank}`
        : `not in the answer (it names ${pt.brandsNamed} other ${pt.brandsNamed === 1 ? "brand" : "brands"}), counted as #${counted(pt, other)}`;
    return {
      movement: counted(f, l) - counted(l, f),
      changeTitle: `${describe(f, l)} on ${f.label} → ${describe(l, f)} on ${l.label}`,
    };
  }

  return Array.from(acc.entries())
    .map(([key, a]) => {
      const platformCells: Record<string, PlatformRankCell> = {};
      for (const platform of platforms) {
        const p = a.byPlatform.get(platform);
        const avgRank = p ? avg(p.primaryRanks) : null;
        let change: Pick<PlatformRankCell, "movement" | "changeTitle"> = { movement: null, changeTitle: null };
        if (mode === "firstLatest") {
          change = firstLatestRankChange(p);
        } else if (hasComparison) {
          const comparisonAvgRank = p ? avg(p.comparisonRanks) : null;
          if (avgRank != null && comparisonAvgRank != null) change = { ...change, movement: comparisonAvgRank - avgRank };
        }
        platformCells[platform] = { avgRank, ...change, checks: p?.primaryChecks ?? 0 };
      }
      const visibilityPct = a.checks ? (a.mentioned / a.checks) * 100 : 0;
      let visibilityChange: number | null = null;
      let visibilityChangeTitle: string | null = null;
      if (mode === "firstLatest") {
        const crawls = Array.from(a.byRun.values()).sort((x, y) => x.date.getTime() - y.date.getTime());
        if (crawls.length >= 2) {
          const f = crawls[0];
          const l = crawls[crawls.length - 1];
          const fPct = (f.mentioned / f.checks) * 100;
          const lPct = (l.mentioned / l.checks) * 100;
          visibilityChange = lPct - fPct;
          visibilityChangeTitle = `${fPct.toFixed(0)}% on ${f.label} → ${lPct.toFixed(0)}% on ${l.label}`;
        }
      } else if (hasComparison) {
        const comparisonVisibilityPct = a.comparisonChecks ? (a.comparisonMentioned / a.comparisonChecks) * 100 : null;
        if (comparisonVisibilityPct != null) visibilityChange = visibilityPct - comparisonVisibilityPct;
      }

      return {
        key,
        text: a.text,
        category: a.category,
        checks: a.checks,
        mentioned: a.mentioned,
        visibilityPct,
        visibilityChange,
        visibilityChangeTitle,
        top3Rate: a.mentioned ? (a.top3Count / a.mentioned) * 100 : null,
        shareOfVoicePct: a.totalMentionRows ? (a.clientMentionRows / a.totalMentionRows) * 100 : null,
        platforms: platformCells,
      };
    })
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

  // Full unbounded span (ignores the active date filter) -- used only to show
  // real dates under the picker's "All Time" option; this page's data
  // starts there anyway. Shared with the Traffic page (see geoAllTimeRange).
  const allTimeRange = geoAllTimeRange(
    completeRuns.map((r) => r.startedAt),
    client.benchmarkSnapshots.map((s) => s.snapshotDate),
  );

  const platformsAvailable = Array.from(
    new Set(completeRuns.flatMap((run) => run.rawResponses.map((r) => r.platform))),
  ).sort();

  const primaryRuns = completeRuns.filter((run) => inWindow(run, dateRange));
  const comparisonRuns = comparisonRange ? completeRuns.filter((run) => inWindow(run, comparisonRange)) : [];

  // Benchmark snapshots in range are the start of the real timeline, not a
  // separate thing -- merged chronologically into the same trend series
  // (flagged isBenchmark so the chart can style the point distinctly) and
  // used below to compute each prompt's movement since the baseline.
  const benchmarksInRange = client.benchmarkSnapshots.filter((s) => inDateWindow(s.snapshotDate, dateRange));

  type DatedPoint = { date: number; point: TrendPoint };
  const datedPoints: DatedPoint[] = [];
  for (const snap of benchmarksInRange) {
    // With the Models filter on one platform, a benchmark with per-platform
    // rows shows that platform's own figure (and no point for a platform it
    // didn't cover); one with combined rows only shows its overall figure.
    // That platform's point sits on the day its rows were measured.
    const rows = perPlatformRows(snap);
    let value = snap.ownVisibilityPct ?? 0;
    let date = snap.snapshotDate;
    if (platformFilter && rows.length) {
      const mine = rows.filter((p) => p.platform === platformFilter);
      if (!mine.length) continue;
      value = (mine.filter((p) => p.position != null).length / mine.length) * 100;
      date = new Date(Math.min(...mine.map((r) => rowDate(snap, r).getTime()))); // its earliest row
    }
    datedPoints.push({
      date: date.getTime(),
      point: {
        runId: `benchmark:${snap.id}`,
        dateLabel: utcDay(date),
        value,
        isBenchmark: true,
      },
    });
  }
  for (const run of primaryRuns) {
    const matching = run.rawResponses.filter(matchesPlatform);
    if (matching.length === 0) continue;
    const mentioned = matching.filter((r) => r.parsedResult?.clientBrandMentioned).length;
    datedPoints.push({
      date: run.startedAt.getTime(),
      point: {
        runId: run.id,
        dateLabel: run.startedAt.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        value: (mentioned / matching.length) * 100,
      },
    });
  }
  const trendPoints: TrendPoint[] = datedPoints.sort((a, b) => a.date - b.date).map((d) => d.point);

  const primaryMatching = primaryRuns.flatMap((run) => run.rawResponses.filter(matchesPlatform));
  const totalResponses = primaryMatching.length;
  const totalMentioned = primaryMatching.filter((r) => r.parsedResult?.clientBrandMentioned).length;
  const headlineVisibility = totalResponses ? (totalMentioned / totalResponses) * 100 : 0;

  const comparisonMatching = comparisonRuns.flatMap((run) => run.rawResponses.filter(matchesPlatform));
  const comparisonTotal = comparisonMatching.length;
  const comparisonMentioned = comparisonMatching.filter((r) => r.parsedResult?.clientBrandMentioned).length;
  const comparisonHeadlineVisibility = comparisonTotal ? (comparisonMentioned / comparisonTotal) * 100 : null;

  const hasComparison = !!comparisonRange && comparisonTotal > 0;

  // Same formulas as the client report's competitor table (src/lib/competitor-table.ts).
  const comparisonVisibility = hasComparison
    ? new Map(competitorStats(comparisonMatching).map((s) => [s.key, s.visibilityPct]))
    : null;
  const brandTable: BrandRow[] = competitorStats(primaryMatching).map((s) => ({
    key: s.key,
    name: s.name,
    isClientBrand: s.isClientBrand,
    appearances: s.appearances,
    avgPosition: s.avgPosition,
    visibilityPct: s.visibilityPct,
    delta: comparisonVisibility ? s.visibilityPct - (comparisonVisibility.get(s.key) ?? 0) : null,
  }));

  // Competitor rank by crawl (the bump chart above the Competitors table):
  // each brand's rank within each crawl alone, by mentions -- same brand keys
  // and Models filter as the table. Ties share a rank (1, 1, 3). Shows the
  // table's top brands for this range, plus the client if it isn't among them.
  const rankKeys = brandTable.slice(0, RANK_CHART_BRANDS).map((b) => b.key);
  const clientRow = brandTable.find((b) => b.isClientBrand);
  if (clientRow && !rankKeys.includes(clientRow.key)) rankKeys.push(clientRow.key);
  // Position / Visibility / Share of Voice per crawl use the table's own
  // formulas (avg list position; answers naming it / answers; mentions / all brands'
  // mentions), scoped to that crawl.
  const rankCrawls: RankCrawl[] = [];
  const rankPoints = new Map<string, BrandCrawlPoint[]>(rankKeys.map((k) => [k, []]));
  for (const run of primaryRuns) {
    const matching = run.rawResponses.filter(matchesPlatform);
    const counts = new Map<string, number>();
    const answersWith = new Map<string, number>(); // answers naming the brand (each answer once), for visibility
    const positions = new Map<string, number[]>();
    for (const r of matching) {
      const seen = new Set<string>();
      for (const m of r.parsedResult?.mentions ?? []) {
        const key = m.brand?.id ?? `raw:${m.rawLabel.toLowerCase()}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!seen.has(key)) answersWith.set(key, (answersWith.get(key) ?? 0) + 1);
        seen.add(key);
        if (m.position != null) positions.set(key, [...(positions.get(key) ?? []), m.position]);
      }
    }
    if (counts.size === 0) continue; // no answers (or no brands) for this filter in this crawl
    const sortedCounts = Array.from(counts.values()).sort((a, b) => b - a);
    const totalMentions = sortedCounts.reduce((a, c) => a + c, 0);
    rankCrawls.push({
      runId: run.id,
      dateLabel: crawlDay(run.startedAt),
      isTraining: !run.rawResponses.some((r) => isLiveSearchModel(r.modelId)),
    });
    for (const key of rankKeys) {
      const n = counts.get(key) ?? 0;
      const pos = positions.get(key) ?? [];
      rankPoints.get(key)!.push({
        mentions: n,
        rank: n ? sortedCounts.indexOf(n) + 1 : null,
        avgPosition: pos.length ? pos.reduce((a, c) => a + c, 0) / pos.length : null,
        visibilityPct: ((answersWith.get(key) ?? 0) / matching.length) * 100,
        sovPct: (n / totalMentions) * 100,
      });
    }
  }
  const rankSeries: RankSeries[] = rankKeys.map((key) => {
    const row = brandTable.find((b) => b.key === key)!;
    return { key, name: row.name, isClientBrand: row.isClientBrand, points: rankPoints.get(key)! };
  });

  // Prompt Rankings ignores the Models filter, so whether its comparison
  // period has data is checked on the unfiltered runs (hasComparison above
  // uses the filtered count, which would blank this table's Change for every
  // platform when filtering to one the comparison period lacks).
  const promptChangeMode: PromptChangeMode = !comparisonRange
    ? "firstLatest"
    : comparisonRuns.some((run) => run.rawResponses.length > 0)
      ? "period"
      : "periodEmpty";
  const promptRankings = buildPromptRankings(primaryRuns, comparisonRuns, promptChangeMode, platformsAvailable, benchmarksInRange);
  const answeredRuns = primaryRuns.filter((run) => run.rawResponses.length > 0);
  const crawlSpan =
    answeredRuns.length >= 2
      ? { first: crawlDay(answeredRuns[0].startedAt), latest: crawlDay(answeredRuns[answeredRuns.length - 1].startedAt) }
      : null;
  // The benchmark that starts Change for the platforms it covers (see buildPromptRankings), for the note.
  const startBenchmark =
    answeredRuns.length >= 1
      ? benchmarksInRange.find((s) => perPlatformRows(s).length && s.snapshotDate < answeredRuns[0].startedAt)
      : undefined;
  const changeStart = startBenchmark
    ? {
        label: `${startBenchmark.source} benchmark (${utcDay(startBenchmark.snapshotDate, true)}${(() => {
          const others = otherDays(startBenchmark.snapshotDate, perPlatformRows(startBenchmark), true);
          return others.length ? `; ${andList(others)}` : "";
        })()})`,
        latest: crawlDay(answeredRuns[answeredRuns.length - 1].startedAt),
        // In the table's column order.
        platforms: platformsAvailable
          .filter((p) => perPlatformRows(startBenchmark).some((r) => r.platform === p))
          .map((p) => PLATFORM_LABEL[p] ?? p),
        uncovered: platformsAvailable
          .filter((p) => !perPlatformRows(startBenchmark).some((r) => r.platform === p))
          .map((p) => PLATFORM_LABEL[p] ?? p),
      }
    : null;

  return {
    platformsAvailable,
    trendPoints,
    headlineVisibility,
    comparisonHeadlineVisibility,
    hasComparison,
    totalResponses,
    brandTable,
    promptRankings,
    promptChangeMode,
    crawlSpan,
    changeStart,
    rankCrawls,
    rankSeries,
    benchmarksInRange,
    allTimeRange,
  };
}

// --- Locations (2026-11-18) -------------------------------------------------
// A client tracked in several places (MacuMira: Canada, Australia, New Zealand)
// gets a Location dropdown. "All locations" (the default) shows each location
// side by side, never blended into one figure; picking one shows this page for
// that location alone. Answers searched with no location (everything before
// locations existed) are their own "No location" entry.

/** The client with only one location's answers ("" = answers with no location). */
function forLocation(client: ClientData, locationId: string): ClientData {
  return {
    ...client,
    runs: client.runs.map((run) => ({
      ...run,
      rawResponses: run.rawResponses.filter((r) => (r.locationId ?? "") === locationId),
    })),
  };
}

type DashboardData = ReturnType<typeof buildDashboardData>;

export default async function ClientRankingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  await requireTab(id, "rankings");
  const sp = await searchParams;
  const model = sp.model;
  const platformFilter = typeof model === "string" && model ? model : undefined;
  const locationParam = typeof sp.location === "string" ? sp.location : "";

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

  // The dropdown's entries: the client's locations, plus "No location" when it has
  // answers searched with none. URL value: the location's id, or "none".
  const hasUnlocated = client.runs.some((run) => run.status === "COMPLETE" && run.rawResponses.some((r) => !r.locationId));
  const locations = client.locations.length
    ? [
        ...client.locations.map((l) => ({ id: l.id, key: l.id, label: l.label })),
        ...(hasUnlocated ? [{ id: "", key: "none", label: "No location" }] : []),
      ]
    : [];
  const selected = locations.find((l) => l.key === locationParam) ?? null;

  const whole = buildDashboardData(client, platformFilter, dateRange, comparisonRange);
  const header = (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}</h1>
        {client.domain && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>}
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {locations.length > 0 && <LocationFilter locations={locations.map((l) => ({ key: l.key, label: l.label }))} />}
        <ModelFilter platforms={whole.platformsAvailable.map((p) => ({ key: p, label: PLATFORM_LABEL[p] ?? p }))} />
        <DateRangePicker allTimeRange={whole.allTimeRange} />
      </div>
    </header>
  );

  // All locations: each one side by side.
  if (locations.length > 0 && !selected) {
    const views = locations.map((l) => ({
      ...l,
      data: buildDashboardData(forLocation(client, l.id), platformFilter, dateRange, comparisonRange),
    }));
    return (
      <div>
        {header}

        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Visibility by Location
          </h2>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {views.map((v) => (
              <div key={v.key} className="min-w-0">
                <VisibilityCard title={v.label} data={v.data} platformFilter={platformFilter} />
                <VisibilityTrendChart points={v.data.trendPoints} />
              </div>
            ))}
          </div>
        </section>

        <section className="mb-8">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Prompt Rankings
          </h2>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            Each location&apos;s answers, searched as if from there. {COMMON_NOTE} Pick a location above to see one on its own.
          </p>
          <div className="space-y-8">
            {views.map((v) => (
              <div key={v.key}>
                <h3 className="mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">{v.label}</h3>
                <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{changeNote(v.data)}</p>
                <PromptRankingTables data={v.data} />
              </div>
            ))}
          </div>
        </section>

        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Competitors by Location
          </h2>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {views.map((v) => (
              <div key={v.key} className="min-w-0">
                <h3 className="mb-2 text-base font-semibold text-zinc-900 dark:text-zinc-100">{v.label}</h3>
                <CompetitorTable data={v.data} platformFilter={platformFilter} limit={10} compact />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Top 10 per location. Pick a location above for its full list and each competitor&apos;s rank crawl by crawl.
            Competitors are detected automatically from run results; manage the tracked list in{" "}
            <a href={`/clients/${id}/competitors`} className="underline">
              Competitors
            </a>
            .
          </p>
        </section>

        <BenchmarkBaseline benchmarks={whole.benchmarksInRange} />
      </div>
    );
  }

  // One location (or a client with no locations): the full page.
  const data = selected ? buildDashboardData(forLocation(client, selected.id), platformFilter, dateRange, comparisonRange) : whole;
  return (
    <div>
      {header}
      {selected && (
        <p className="-mt-3 mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Showing <span className="font-medium text-zinc-900 dark:text-zinc-100">{selected.label}</span> only
          {selected.id ? ": answers searched as if from there." : ": answers searched with no location set."}
        </p>
      )}

      <section className="mb-8">
        <VisibilityCard data={data} platformFilter={platformFilter} />
        <VisibilityTrendChart points={data.trendPoints} />
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Prompt Rankings
        </h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {COMMON_NOTE} {changeNote(data)}
        </p>
        <PromptRankingTables data={data} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Competitors
        </h2>
        {data.brandTable.length > 0 && data.rankCrawls.length > 0 && (
          <CompetitorRankChart crawls={data.rankCrawls} series={data.rankSeries} brandCount={RANK_CHART_BRANDS} />
        )}
        <CompetitorTable data={data} platformFilter={platformFilter} limit={15} />
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Competitors are detected automatically from run results. Manage the tracked list in{" "}
          <a href={`/clients/${id}/competitors`} className="underline">
            Competitors
          </a>
          .
        </p>
      </section>

      <BenchmarkBaseline benchmarks={data.benchmarksInRange} />
    </div>
  );
}

const COMMON_NOTE =
  "Shown per platform regardless of the Models filter above. An answer that cites your site without naming you counts as #1, the same as a mention outside the AI's list.";

/** What the Prompt Rankings Change columns compare, for this view's data. */
function changeNote(data: DashboardData): string {
  const { promptChangeMode, changeStart, crawlSpan } = data;
  if (promptChangeMode === "period") return "Change is vs. the comparison period selected in the date picker.";
  if (promptChangeMode === "periodEmpty") return "No crawls fall in the selected Compare To period, so Change is blank.";
  if (changeStart) {
    const uncovered = changeStart.uncovered;
    return `Change is each prompt's most recent crawl (${changeStart.latest}) vs. the ${changeStart.label}, platform by platform, for ${andList(changeStart.platforms)}${uncovered.length ? `; ${andList(uncovered)} ${uncovered.length === 1 ? "wasn't" : "weren't"} part of the benchmark, so ${uncovered.length === 1 ? "its" : "their"} Change starts at ${uncovered.length === 1 ? "its" : "their"} first crawl` : ""}. An answer that leaves you out counts as one place below the last brand it names and always below your rank in the other crawl. Hover a Change for details, or pick a "Compare To" period in the date picker to compare periods instead.`;
  }
  if (crawlSpan) {
    return `Change is each prompt's most recent crawl vs. its first crawl in this range (${crawlSpan.first} to ${crawlSpan.latest}). An answer that leaves you out counts as one place below the last brand it names and always below your rank in the other crawl. Hover a Change for details, or pick a "Compare To" period in the date picker to compare periods instead.`;
  }
  return 'Change needs at least two crawls in this range. Pick a "Compare To" period in the date picker to compare periods instead.';
}

/** The Visibility Score card (with a location's name above it in the All locations view). */
function VisibilityCard({ data, platformFilter, title }: { data: DashboardData; platformFilter: string | undefined; title?: string }) {
  const { headlineVisibility, comparisonHeadlineVisibility, hasComparison, totalResponses } = data;
  const scoreDelta =
    hasComparison && comparisonHeadlineVisibility != null ? headlineVisibility - comparisonHeadlineVisibility : null;
  return (
    <div className="mb-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      {title && <div className="mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</div>}
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Visibility Score</div>
      <div className="mt-1 flex items-baseline gap-3">
        <div className="text-3xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">{headlineVisibility.toFixed(1)}%</div>
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
  );
}

/** Prompt Rankings: a table per category, each platform with its own Rank and Change. */
function PromptRankingTables({ data }: { data: DashboardData }) {
  const { promptRankings, platformsAvailable } = data;
  if (promptRankings.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
        No completed runs in this range.
      </div>
    );
  }
  const promptGroups = new Map<string, PromptRankRow[]>();
  for (const p of promptRankings) {
    const list = promptGroups.get(p.category ?? "uncategorized") ?? [];
    list.push(p);
    promptGroups.set(p.category ?? "uncategorized", list);
  }
  return (
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
                  {/* Prompt column stays pinned while the platform columns scroll sideways (phones). */}
                  <th rowSpan={2} className={`${PROMPT_COL} bg-zinc-100 px-4 py-2 align-bottom font-medium dark:bg-zinc-900`}>
                    Prompt
                  </th>
                  {platformsAvailable.map((platform) => (
                    <th
                      key={platform}
                      colSpan={2}
                      className="border-l border-zinc-200 px-2 py-1 text-center font-medium whitespace-nowrap dark:border-zinc-800"
                    >
                      {PLATFORM_LABEL[platform] ?? platform}
                    </th>
                  ))}
                  <th colSpan={2} className="border-l border-zinc-200 px-2 py-1 text-center font-medium whitespace-nowrap dark:border-zinc-800">
                    Visibility
                  </th>
                  <th rowSpan={2} className="px-2.5 py-2 align-bottom font-medium tabular-nums">
                    Top-3 Rate
                  </th>
                  <th rowSpan={2} className="px-2.5 py-2 align-bottom font-medium tabular-nums">
                    Share of Voice
                  </th>
                </tr>
                <tr>
                  {platformsAvailable.map((platform) => (
                    <Fragment key={platform}>
                      <th className="border-l border-zinc-200 px-2 py-1.5 text-right font-medium tabular-nums dark:border-zinc-800">
                        Rank
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium tabular-nums">Change</th>
                    </Fragment>
                  ))}
                  <th className="border-l border-zinc-200 px-2 py-1.5 text-right font-medium tabular-nums dark:border-zinc-800">
                    %
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium tabular-nums">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {prompts.map((p) => (
                  <tr key={p.key} className="bg-white dark:bg-zinc-950">
                    <td className={`${PROMPT_COL} bg-white px-4 py-2 text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300`}>{p.text}</td>
                    {platformsAvailable.map((platform) => {
                      const cell = p.platforms[platform];
                      return (
                        <Fragment key={platform}>
                          <td className="border-l border-zinc-100 px-2 py-2 text-right tabular-nums whitespace-nowrap dark:border-zinc-900">
                            {cell?.avgRank != null ? cell.avgRank.toFixed(1) : "—"}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap" title={cell?.changeTitle ?? undefined}>
                            {cell?.movement == null ? (
                              <span className="text-zinc-300 dark:text-zinc-700">—</span>
                            ) : (
                              <span
                                className={
                                  cell.movement > 0
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : cell.movement < 0
                                      ? "text-red-600 dark:text-red-400"
                                      : "text-zinc-400 dark:text-zinc-600"
                                }
                              >
                                {cell.movement > 0 ? "+" : cell.movement < 0 ? "-" : "–"}
                                {cell.movement !== 0 ? Math.abs(cell.movement).toFixed(1) : ""}
                              </span>
                            )}
                          </td>
                        </Fragment>
                      );
                    })}
                    <td className="border-l border-zinc-100 px-2 py-2 text-right tabular-nums whitespace-nowrap dark:border-zinc-900">
                      {p.visibilityPct.toFixed(0)}%
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap" title={p.visibilityChangeTitle ?? undefined}>
                      {p.visibilityChange == null ? (
                        <span className="text-zinc-300 dark:text-zinc-700">—</span>
                      ) : (
                        <span
                          className={
                            p.visibilityChange > 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : p.visibilityChange < 0
                                ? "text-red-600 dark:text-red-400"
                                : "text-zinc-400 dark:text-zinc-600"
                          }
                        >
                          {p.visibilityChange > 0 ? "+" : p.visibilityChange < 0 ? "-" : "–"}
                          {p.visibilityChange !== 0 ? Math.abs(p.visibilityChange).toFixed(0) + "pp" : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-2.5 py-2 tabular-nums whitespace-nowrap">{p.top3Rate != null ? `${p.top3Rate.toFixed(0)}%` : "—"}</td>
                    <td className="px-2.5 py-2 tabular-nums whitespace-nowrap">
                      {p.shareOfVoicePct != null ? `${p.shareOfVoicePct.toFixed(0)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The Competitors table (compact: narrower cells, for a location's column in the All locations view). */
function CompetitorTable({
  data,
  platformFilter,
  limit,
  compact = false,
}: {
  data: DashboardData;
  platformFilter: string | undefined;
  limit: number;
  compact?: boolean;
}) {
  const { brandTable, hasComparison } = data;
  if (brandTable.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
        No completed runs in this range{platformFilter ? " for this platform" : ""}.
      </div>
    );
  }
  const cell = compact ? "px-2 py-2" : "px-4 py-3";
  const head = compact ? "px-2 py-2" : "px-4 py-2";
  const totalAppearances = brandTable.reduce((a, c) => a + c.appearances, 0);
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            <th className={`${head} font-medium`}>Rank</th>
            <th className={`${head} font-medium`}>Brand</th>
            <th className={`${head} font-medium tabular-nums`}>Position</th>
            <th className={`${head} font-medium tabular-nums`}>Visibility</th>
            <th className={`${head} font-medium tabular-nums`}>Share of Voice</th>
            {hasComparison && <th className={`${head} font-medium tabular-nums`}>Change</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {brandTable.slice(0, limit).map((b, i) => {
            const sov = totalAppearances ? (b.appearances / totalAppearances) * 100 : 0;
            return (
              <tr key={b.key} className={b.isClientBrand ? "bg-blue-50 dark:bg-blue-950/40" : "bg-white dark:bg-zinc-950"}>
                <td className={`${cell} tabular-nums text-zinc-500 dark:text-zinc-400`}>#{i + 1}</td>
                <td className={`${cell} font-medium text-zinc-900 dark:text-zinc-100`}>
                  {b.name}
                  {b.isClientBrand && (
                    <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                      You
                    </span>
                  )}
                </td>
                <td className={`${cell} tabular-nums`}>{b.avgPosition != null ? b.avgPosition.toFixed(1) : "—"}</td>
                <td className={`${cell} tabular-nums`}>{b.visibilityPct.toFixed(1)}%</td>
                <td className={`${cell} tabular-nums`}>{sov.toFixed(1)}%</td>
                {hasComparison && (
                  <td className={`${cell} tabular-nums`}>
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
  );
}

/** The imported benchmark's own competitor list (shown once, under everything else). */
function BenchmarkBaseline({ benchmarks }: { benchmarks: DashboardData["benchmarksInRange"] }) {
  if (benchmarks.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Benchmark Competitor Baseline
      </h2>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        Competitor standing as of the baseline date (shown on the Visibility chart above).
      </p>
      <div className="space-y-6">
        {benchmarks.map((snap) => (
          <div
            key={snap.id}
            className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-900/40"
          >
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {snap.source} baseline — {snap.snapshotDate.toLocaleDateString(undefined, {
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
                        <td className="px-3 py-1.5 tabular-nums">{c.visibilityPct != null ? `${c.visibilityPct}%` : "—"}</td>
                        <td className="px-3 py-1.5 tabular-nums">{c.sentiment ?? "—"}</td>
                        <td className="px-3 py-1.5 tabular-nums">{c.shareOfVoicePct != null ? `${c.shareOfVoicePct}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {snap.sourceNote && <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-600">{snap.sourceNote}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
