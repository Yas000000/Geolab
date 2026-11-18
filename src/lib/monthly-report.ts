import { prisma } from "@/lib/prisma";
import { PLATFORM_LABEL } from "@/lib/geo-platform-map";
import { benchmarkDateGroups } from "@/lib/benchmark-dates";
import { estimateDirectAiSessions } from "@/lib/ai-traffic";
import { citationTrackedRuns, isLiveSearchModel, siteDomain, summarizeCitations, type CitedAnswer } from "@/lib/citations";
import { CRAWL_VENDOR_LABEL, latestCrawlCheck } from "@/lib/crawl-check";
import { competitorStats, matchBenchmarkNames, nameKeys } from "@/lib/competitor-table";
import {
  daysLabel,
  isoDay,
  makePeriod,
  monthPeriod,
  periodBounds,
  periodDays,
  periodEndingOn,
  previousPeriod,
  type CompareSpec,
  type ReportPeriod,
} from "@/lib/report-period";

// The client report: one period of days (default: the last full calendar
// month) against a comparison, from this portal's own data (replaces
// geo-monthly-report's keyword.com CSV diffing for portal clients). The
// comparison is, by default, the client's imported benchmark (e.g. the ISA),
// else its first crawl; or the period before, or any range of days. Days
// are UTC calendar days.

export interface ScoreMetrics {
  checks: number;
  visibilityPct: number; // % of checks that mentioned the client
  avgRankWhenFound: number | null;
  rank1Count: number; // checks where the client was #1
  top3Pct: number; // % of ALL checks where the client ranked top 3 (same formula as geo-monthly-report)
  sentimentPct: number | null; // % of mentions that weren't negative (same formula as the run page)
}

/** The comparison side of the scorecard. An imported benchmark only has some of the figures (null = not in it). */
export type CompareScore = { [K in keyof ScoreMetrics]: ScoreMetrics[K] | null };

export interface PlatformRow {
  platform: string;
  label: string;
  current: { checks: number; visibilityPct: number; avgRank: number | null } | null;
  // Against an imported benchmark this is the benchmark's all-platform figure (checks: null).
  previous: { checks: number | null; visibilityPct: number; avgRank: number | null } | null;
}

export interface PromptMove {
  text: string;
  previouslyTracked: boolean; // false = not in the comparison, so "then" is unknown, not "not found"
  previousBestRank: number | null;
  currentBestRank: number | null;
  outrankedBy?: string | null; // the brand most often at #1 when the client wasn't
  // Each engine's own best rank then and now, laid out like the Monthly GEO Report
  // tool's Win/Loss tables (the user's call, 2026-11-18): null = not found; a key left
  // out = no data (not in the comparison, or no answer on that engine). Older saved
  // reports have none and keep their best-rank layout.
  engines?: Record<string, EngineRank>;
}

export interface EngineRank {
  then?: number | null;
  now?: number | null;
}

/** One brand's figures, as the GEO Rankings tab's Competitors table computes them. */
export interface CompetitorFigures {
  position: number | null; // average list position when mentioned
  visibilityPct: number | null; // answers naming it / answers (competitor-table.ts)
  sharePct: number | null; // mentions / all brands' mentions
}

export interface CompetitorRow {
  name: string;
  isClient: boolean;
  rank: number | null; // by mentions in the report period, as on the Rankings tab; null = not mentioned
  current: CompetitorFigures | null; // null = not mentioned in the report period
  previous: CompetitorFigures | null; // null = nothing to compare (an imported benchmark lists only its top competitors)
  benchmarkName: string | null; // what an imported benchmark called it, e.g. "mcleanhospital.org"
}

export interface CitationSection {
  current: { answers: number; ownSitePct: number; answersCitingOwnSite: number; sitesCited: number };
  previous: { answers: number; ownSitePct: number } | null;
  topSites: { domain: string; isOwn: boolean; sharePct: number; previousSharePct: number | null }[];
  ownPages: { url: string; title: string | null; answers: number }[];
}

export interface TrafficTotals {
  sessions: number | null;
  aiAssistant: number;
  referralAi: number;
  unassignedAi: number;
  measuredAiTotal: number;
  direct: number;
  directAiEstimate: { low: number; high: number };
  gscClicks: number | null;
  gscImpressions: number | null;
  days: number; // days with Google Analytics data -- below daysInPeriod means a partial period
  daysInPeriod: number;
}

/** One row of an imported benchmark's competitor table, as the source document reports it. */
export interface BenchmarkCompetitorRow {
  name: string;
  sharePct: number | null;
  visibilityPct: number | null;
  position: number | null;
  shownAs?: string | null; // the tracked brand it matched, as named in the report's competitor table
}

export interface ReportComparison {
  kind: CompareSpec["kind"];
  label: string; // short, for column headers: "ISA Benchmark", "First Crawl", "September 2026"
  phrase: string; // inside sentences: "the ISA benchmark (Mar 17, 2026)", "September 2026"
  date: string | null; // when the benchmark or first crawl was taken, e.g. "Mar 17, 2026"
  period: ReportPeriod | null; // the days of GEO runs compared (null for an imported benchmark)
  trafficPeriod: ReportPeriod | null; // the Google Analytics days compared
  source: string | null; // an imported benchmark's source, e.g. "ISA"
  sentimentScore: number | null; // an imported benchmark's own 0-100 sentiment score (compared as a %)
  competitors: BenchmarkCompetitorRow[] | null; // an imported benchmark's competitor table
  assumedZero?: string[]; // scorecard figures an imported benchmark didn't report, counted as 0 (zeroFillBenchmark)
  fromPromptTable?: string[]; // scorecard figures worked out from its prompt table, not stated by it (benchmarkPromptFigures)
  ownSiteCitedPct?: number | null; // an imported benchmark's % of answers citing the client's site, when it has it
  byPlatform?: boolean; // an imported benchmark with figures per platform (so each platform is compared with its own)
  // An imported benchmark's rows measured on other days than its own date:
  // ["those for 9 prompts are from Jun 1, 2026", "Claude's are from Oct 19, 2026"].
  dateNotes?: string[];
}

export interface RunCounts {
  runs: number;
  live: number;
  training: number;
}

/** One location's chapter in an "All locations" report: its own data and takeaways. */
export interface LocationReport {
  key: string; // ClientLocation id, or "none" (answers searched with no location)
  label: string;
  data: MonthlyReportData;
  takeaways: ReportTakeaways;
}

export interface MonthlyReportData {
  // A report for one location (its answers only); unset for a whole-client report.
  location?: { key: string; label: string } | null;
  // "All locations" for a client with locations: every location in its own chapter (side
  // by side on the Locations at a Glance page). This report's own figures then cover only
  // what isn't split by location (traffic, crawler access).
  byLocation?: LocationReport[];
  period: ReportPeriod;
  compare: ReportComparison;
  clientName: string;
  domain: string | null;
  brandName: string | null;
  runs: { current: RunCounts; previous: RunCounts | null };
  scorecard: { current: ScoreMetrics; previous: CompareScore | null };
  platforms: PlatformRow[];
  prompts: {
    tracked: number;
    compared: boolean;
    gainsIncludeNewWins?: boolean; // reports saved before this rule get it on open (normalizeReportData)
    newWins: PromptMove[];
    rankGains: PromptMove[]; // includes every new win: unranked then, ranked now
    watchlist: PromptMove[];
    // The engine columns (in this order) for PromptMove.engines; thenByEngine is false when
    // the comparison has only one combined figure per prompt (Yellowbrick's ISA).
    engines?: { platform: string; label: string }[];
    thenByEngine?: boolean;
  };
  competitors: CompetitorRow[];
  citations: CitationSection | null;
  traffic: { current: TrafficTotals; previous: TrafficTotals | null } | null;
  crawl: { checkedAt: string; url: string; results: { label: string; success: boolean }[] } | null;
}

export type ReportTakeaways = Partial<Record<"scorecard" | "platforms" | "prompts" | "competitors" | "citations" | "traffic", string>>;

/**
 * Saved reports in older shapes, mapped to the current one so they still open:
 * - before custom periods (2026-11-17): one month against the month before,
 *   with month/monthLabel/previousMonth fields and daysInMonth;
 * - before the Rankings-style competitor table (reports from dff78ff):
 *   competitor rows of currentSovPct/previousSovPct/currentVisibilityPct.
 */
type LegacyTraffic = Omit<TrafficTotals, "daysInPeriod"> & { daysInMonth: number };
type LegacyCompetitor = { name: string; isClient: boolean; currentSovPct: number; previousSovPct: number | null; currentVisibilityPct: number };
type LegacyReport = Omit<MonthlyReportData, "period" | "compare" | "prompts" | "traffic" | "competitors"> & {
  month: string;
  previousMonth: string;
  prompts: Omit<MonthlyReportData["prompts"], "compared">;
  competitors: LegacyCompetitor[];
  traffic: { current: LegacyTraffic; previous: LegacyTraffic | null } | null;
};

export function normalizeReportData(raw: unknown): MonthlyReportData {
  const d = (raw as MonthlyReportData).period ? (raw as MonthlyReportData) : fromMonthReport(raw as LegacyReport);
  // Old competitor rows compared Share of Voice only, and only with tracked runs.
  const compared = d.compare.kind !== "benchmark" && !!d.scorecard.previous;
  const competitors = (d.competitors as (CompetitorRow | LegacyCompetitor)[]).map((x, i): CompetitorRow =>
    "currentSovPct" in x
      ? {
          name: x.name,
          isClient: x.isClient,
          rank: i + 1,
          current: { position: null, visibilityPct: x.currentVisibilityPct, sharePct: x.currentSovPct },
          previous: compared ? { position: null, visibilityPct: null, sharePct: x.previousSovPct ?? 0 } : null,
          benchmarkName: null,
        }
      : x,
  );
  // Reports saved before new wins counted as rank gains too.
  const prompts = d.prompts.gainsIncludeNewWins
    ? d.prompts
    : { ...d.prompts, gainsIncludeNewWins: true, rankGains: [...d.prompts.newWins, ...d.prompts.rankGains].sort(byBestRank) };
  const out = zeroFillBenchmark({ ...d, competitors, prompts });
  return d.byLocation ? { ...out, byLocation: d.byLocation.map((l) => ({ ...l, data: normalizeReportData(l.data) })) } : out;
}

function fromMonthReport(raw: LegacyReport): MonthlyReportData {
  const { month, previousMonth, competitors, ...r } = raw;
  const period = monthPeriod(month);
  const prev = monthPeriod(previousMonth);
  const fix = ({ daysInMonth, ...t }: LegacyTraffic): TrafficTotals => ({ ...t, daysInPeriod: daysInMonth });
  return {
    ...r,
    competitors: competitors as unknown as CompetitorRow[], // mapped by normalizeReportData
    period,
    compare: {
      kind: "previous",
      label: prev.label,
      phrase: prev.label,
      date: null,
      period: prev,
      trafficPeriod: prev,
      source: null,
      sentimentScore: null,
      competitors: null,
    },
    prompts: { ...r.prompts, compared: !!r.scorecard.previous },
    traffic: r.traffic && { current: fix(r.traffic.current), previous: r.traffic.previous && fix(r.traffic.previous) },
  };
}

type RunWhere = { startedAt: { gte: Date; lt: Date } } | { id: { in: string[] } };

async function loadRuns(clientId: string, where: RunWhere) {
  return prisma.run.findMany({
    where: { clientId, status: "COMPLETE", ...where },
    orderBy: { startedAt: "asc" },
    select: {
      startedAt: true,
      rawResponses: {
        // Empty text = a failed call (e.g. Gemini quota errors) -- not a real check.
        where: { responseText: { not: "" } },
        select: {
          platform: true,
          locationId: true,
          modelId: true,
          responseText: true, // an answer naming the client's site counts as citing it (citations.ts)
          prompt: { select: { text: true, category: true } },
          citations: { orderBy: { position: "asc" }, select: { url: true, title: true, domain: true } },
          parsedResult: {
            select: {
              clientBrandMentioned: true,
              clientBrandRank: true,
              sentiment: true,
              mentions: { select: { position: true, rawLabel: true, brand: { select: { id: true, name: true, isClientBrand: true } } } },
            },
          },
        },
      },
    },
  });
}

const inPeriod = (p: ReportPeriod): RunWhere => {
  const b = periodBounds(p);
  return { startedAt: { gte: b.start, lt: b.end } };
};

type RunRows = Awaited<ReturnType<typeof loadRuns>>;

/** Runs with only one location's answers ("none" = answers searched with no location); undefined = all. */
function onlyLocation(runs: RunRows, locationKey: string | undefined): RunRows {
  if (locationKey === undefined) return runs;
  return runs.map((r) => ({ ...r, rawResponses: r.rawResponses.filter((x) => (x.locationId ?? "none") === locationKey) }));
}
type Check = RunRows[number]["rawResponses"][number];

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const promptKey = (text: string) => text.trim().toLowerCase();

function scoreMetrics(checks: Check[]): ScoreMetrics {
  const mentioned = checks.filter((c) => c.parsedResult?.clientBrandMentioned);
  const ranks = mentioned.map((c) => c.parsedResult?.clientBrandRank).filter((r): r is number => r != null);
  return {
    checks: checks.length,
    visibilityPct: pct(mentioned.length, checks.length),
    avgRankWhenFound: avg(ranks),
    rank1Count: ranks.filter((r) => r === 1).length,
    top3Pct: pct(ranks.filter((r) => r <= 3).length, checks.length),
    sentimentPct: mentioned.length
      ? pct(mentioned.filter((c) => c.parsedResult?.sentiment !== "NEGATIVE").length, mentioned.length)
      : null,
  };
}

function runCounts(runs: RunRows): RunCounts {
  let live = 0;
  for (const run of runs) if (run.rawResponses.some((r) => isLiveSearchModel(r.modelId))) live += 1;
  return { runs: runs.length, live, training: runs.length - live };
}

function platformRows(current: Check[], previous: Check[]): PlatformRow[] {
  const stats = (checks: Check[]) => {
    if (!checks.length) return null;
    const m = scoreMetrics(checks);
    return { checks: m.checks, visibilityPct: m.visibilityPct, avgRank: m.avgRankWhenFound };
  };
  const platforms = [...new Set([...current, ...previous].map((c) => c.platform))].sort();
  return platforms.map((p) => ({
    platform: p,
    label: PLATFORM_LABEL[p] ?? p,
    current: stats(current.filter((c) => c.platform === p)),
    previous: stats(previous.filter((c) => c.platform === p)),
  }));
}

/** How a prompt did in the comparison: from its checks, or an imported benchmark's prompt table. */
interface PromptThen {
  found: boolean;
  bestRank: number | null;
  // Each engine's best rank then (null = not found on it); none when the comparison only
  // has one combined figure per prompt.
  byEngine?: Map<string, number | null>;
}

function groupByPrompt(checks: Check[]) {
  const m = new Map<string, { text: string; checks: Check[] }>();
  for (const c of checks) {
    const key = promptKey(c.prompt.text);
    const a = m.get(key) ?? { text: c.prompt.text, checks: [] };
    a.checks.push(c);
    m.set(key, a);
  }
  return m;
}

const bestRank = (checks: Check[]) => {
  const ranks = checks
    .filter((c) => c.parsedResult?.clientBrandMentioned)
    .map((c) => c.parsedResult?.clientBrandRank)
    .filter((r): r is number => r != null);
  return ranks.length ? Math.min(...ranks) : null;
};
const found = (checks: Check[]) => checks.some((c) => c.parsedResult?.clientBrandMentioned);

function promptsThen(checks: Check[]): Map<string, PromptThen> {
  const out = new Map<string, PromptThen>();
  for (const [key, a] of groupByPrompt(checks)) {
    out.set(key, { found: found(a.checks), bestRank: bestRank(a.checks), byEngine: ranksByEngine(a.checks) });
  }
  return out;
}

/** A prompt's best rank on each engine it was asked on (null = asked, not found). */
function ranksByEngine(checks: Check[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const platform of new Set(checks.map((c) => c.platform))) {
    out.set(platform, bestRank(checks.filter((c) => c.platform === platform)));
  }
  return out;
}

function promptMoves(current: Check[], then: Map<string, PromptThen> | null) {
  const leader = (checks: Check[]) => {
    const counts = new Map<string, number>();
    for (const c of checks) {
      if ((c.parsedResult?.clientBrandRank ?? 0) === 1) continue;
      const top = c.parsedResult?.mentions.find((m) => m.position === 1);
      if (!top || top.brand?.isClientBrand) continue;
      const name = top.brand?.name ?? top.rawLabel;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };

  const cur = groupByPrompt(current);
  // Engine columns: every engine in the period or the comparison, in a fixed order.
  // Which bucket a prompt lands in still goes by its best rank on any engine (the
  // Monthly GEO Report tool does the same); the columns show each engine's own move.
  const thenByEngine = [...(then?.values() ?? [])].some((p) => p.byEngine);
  const platforms = new Set<string>(current.map((c) => c.platform));
  for (const p of then?.values() ?? []) for (const platform of p.byEngine?.keys() ?? []) platforms.add(platform);
  const engines = [...platforms].sort().map((platform) => ({ platform, label: PLATFORM_LABEL[platform] ?? platform }));
  const newWins: PromptMove[] = [];
  const rankGains: PromptMove[] = [];
  const watchlist: PromptMove[] = [];
  for (const [key, a] of cur) {
    const p = then?.get(key);
    const currentBestRank = bestRank(a.checks);
    const previousBestRank = p?.bestRank ?? null;
    const nowByEngine = ranksByEngine(a.checks);
    const byEngine: Record<string, EngineRank> = {};
    for (const { platform } of engines) {
      const cell: EngineRank = {};
      if (p?.byEngine?.has(platform)) cell.then = p.byEngine.get(platform)!;
      if (nowByEngine.has(platform)) cell.now = nowByEngine.get(platform)!;
      byEngine[platform] = cell;
    }
    const move = { text: a.text, previouslyTracked: !!p, previousBestRank, currentBestRank, engines: byEngine };
    // A prompt that isn't in the comparison is new to tracking, not a win.
    // Unranked then and ranked now is a rank gain too (the user's rule,
    // 2026-11-17), so every new win is also listed under Rank Gains.
    if (p && !p.found && found(a.checks)) {
      newWins.push(move);
      rankGains.push(move);
    } else if (p && p.found && currentBestRank != null && previousBestRank != null && currentBestRank < previousBestRank)
      rankGains.push(move);
    else if (found(a.checks) && currentBestRank != null && currentBestRank > 1)
      watchlist.push({ ...move, outrankedBy: leader(a.checks) });
  }
  return {
    tracked: cur.size,
    compared: !!then && then.size > 0,
    gainsIncludeNewWins: true,
    newWins: newWins.sort(byBestRank),
    rankGains: rankGains.sort(byBestRank),
    watchlist: watchlist.sort(byBestRank),
    engines,
    thenByEngine,
  };
}

const byBestRank = (x: PromptMove, y: PromptMove) =>
  (x.currentBestRank ?? 99) - (y.currentBestRank ?? 99) || x.text.localeCompare(y.text);

/** Competitor rows shown in the report: the Rankings tab's top brands, plus the client. */
export const COMPETITOR_ROWS = 15;

/** An imported benchmark's competitor list matched to tracked brands, and the client's own benchmark figures. */
interface BenchmarkForRows {
  list: BenchmarkCompetitorRow[];
  matches: Map<string, string>; // benchmark name -> brand id
  client: CompetitorFigures | null;
}

/**
 * The Rankings tab's Competitors table for the report period, with each
 * brand's figures in the comparison: from the comparison's answers (a brand
 * they never mention is a real 0), or from an imported benchmark's own
 * competitor list (matched to tracked brands by name or website; a brand
 * outside that list has no comparison figure).
 */
function competitorRows(
  current: Check[],
  previous: Check[] | null,
  benchmark: BenchmarkForRows | null,
  ownBrand: { key: string; name: string } | null,
): CompetitorRow[] {
  const cur = competitorStats(current, ownBrand);
  const rankOf = new Map(cur.map((s, i) => [s.key, i + 1]));
  const figures = (s: { avgPosition: number | null; visibilityPct: number; sharePct: number }): CompetitorFigures => ({
    position: s.avgPosition,
    visibilityPct: s.visibilityPct,
    sharePct: s.sharePct,
  });
  const prev = previous && previous.length ? new Map(competitorStats(previous, ownBrand).map((s) => [s.key, s])) : null;
  // Benchmark rows by the brand they matched (the first, i.e. largest share, wins if two match one brand).
  const fromBenchmark = new Map<string, BenchmarkCompetitorRow>();
  for (const b of benchmark?.list ?? []) {
    const id = benchmark!.matches.get(b.name);
    if (id && !fromBenchmark.has(id)) fromBenchmark.set(id, b);
  }

  const keys = cur.slice(0, COMPETITOR_ROWS).map((s) => s.key);
  const client = cur.find((s) => s.isClientBrand);
  if (client && !keys.includes(client.key)) keys.push(client.key);
  for (const id of fromBenchmark.keys()) if (rankOf.has(id) && !keys.includes(id)) keys.push(id);

  const byKey = new Map(cur.map((s) => [s.key, s]));
  return keys
    .map((key) => {
      const s = byKey.get(key)!;
      const b = fromBenchmark.get(key);
      let previousFigures: CompetitorFigures | null = null;
      if (b) previousFigures = { position: b.position, visibilityPct: b.visibilityPct, sharePct: b.sharePct };
      else if (s.isClientBrand && benchmark?.client) previousFigures = benchmark.client;
      else if (prev) {
        const p = prev.get(key);
        previousFigures = p ? figures(p) : { position: null, visibilityPct: 0, sharePct: 0 };
      }
      return {
        name: s.name,
        isClient: s.isClientBrand,
        rank: rankOf.get(key) ?? null,
        current: figures(s),
        previous: previousFigures,
        benchmarkName: b && nameKeys(b.name)[0] !== nameKeys(s.name)[0] ? b.name : null,
      };
    })
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
}

function citationSection(current: RunRows, previous: RunRows, ownDomain: string | null): CitationSection | null {
  const toAnswers = (runs: RunRows): CitedAnswer[] =>
    citationTrackedRuns(runs)
      .flatMap((run) => run.rawResponses)
      .filter((c) => isLiveSearchModel(c.modelId))
      .map((c) => ({
        platform: c.platform,
        promptText: c.prompt.text,
        promptCategory: c.prompt.category,
        citations: c.citations,
        responseText: c.responseText,
      }));
  const curAnswers = toAnswers(current);
  if (!curAnswers.length) return null;
  const cur = summarizeCitations(curAnswers, ownDomain);
  const prevAnswers = toAnswers(previous);
  const prev = prevAnswers.length ? summarizeCitations(prevAnswers, ownDomain) : null;
  const prevShare = new Map(prev?.sites.map((s) => [s.domain, s.sharePct]) ?? []);
  return {
    current: { answers: cur.answers, ownSitePct: cur.ownSitePct, answersCitingOwnSite: cur.answersCitingOwnSite, sitesCited: cur.sites.length },
    previous: prev ? { answers: prev.answers, ownSitePct: prev.ownSitePct } : null,
    // 8 sites and 4 pages keep the section on one printed sheet; the takeaway
    // only sees these, so it can't name a site the table doesn't show.
    topSites: cur.sites.slice(0, 8).map((s) => ({
      domain: s.domain,
      isOwn: s.isOwn,
      sharePct: s.sharePct,
      previousSharePct: prev ? (prevShare.get(s.domain) ?? 0) : null,
    })),
    ownPages: cur.pages.filter((p) => p.isOwn).slice(0, 4).map((p) => ({ url: p.url, title: p.title, answers: p.answers })),
  };
}

async function trafficTotals(clientId: string, period: ReportPeriod): Promise<TrafficTotals | null> {
  const b = periodBounds(period);
  const where = { clientId, date: { gte: b.start, lt: b.end } };
  const [ga4, ai, gsc] = await Promise.all([
    prisma.analyticsSnapshot.findMany({ where, select: { sessions: true } }),
    prisma.aiTrafficSnapshot.findMany({ where }),
    prisma.searchConsoleSnapshot.findMany({ where, select: { clicks: true, impressions: true } }),
  ]);
  if (!ga4.length && !ai.length && !gsc.length) return null;
  const sum = <T,>(rows: T[], f: (r: T) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  const aiAssistant = sum(ai, (r) => r.aiAssistantSessions);
  const referralAi = sum(ai, (r) => r.referralAiSessions);
  const unassignedAi = sum(ai, (r) => r.unassignedAiSessions);
  const direct = sum(ai, (r) => r.directSessions);
  const est = estimateDirectAiSessions(direct);
  return {
    sessions: ga4.length ? sum(ga4, (r) => r.sessions) : null,
    aiAssistant,
    referralAi,
    unassignedAi,
    measuredAiTotal: aiAssistant + referralAi + unassignedAi,
    direct,
    directAiEstimate: { low: est.low, high: est.high },
    gscClicks: gsc.length ? sum(gsc, (r) => r.clicks) : null,
    gscImpressions: gsc.length ? sum(gsc, (r) => r.impressions) : null,
    days: Math.max(ga4.length, ai.length),
    daysInPeriod: periodDays(period.start, period.end),
  };
}

/**
 * Why the two traffic columns can't be compared as totals (missing days of
 * Google Analytics data, or periods of different lengths), or null when they
 * can. Shared by the report page and the traffic takeaway.
 */
export function trafficCaveat(traffic: { current: TrafficTotals; previous: TrafficTotals | null }, curLabel: string, prevLabel: string): string | null {
  const cur = traffic.current;
  const prev = traffic.previous;
  const partial = (t: TrafficTotals | null) => !!t && t.days < t.daysInPeriod;
  if (partial(cur) || partial(prev)) {
    const cover = (t: TrafficTotals, label: string) => `${t.days} of ${t.daysInPeriod} days in ${label}`;
    return `Google Analytics data covers ${cover(cur, curLabel)}${prev ? ` and ${cover(prev, prevLabel)}` : ""}, so the totals can't be compared directly.`;
  }
  if (prev && prev.daysInPeriod !== cur.daysInPeriod) {
    return `${curLabel} has ${cur.daysInPeriod} days and ${prevLabel} has ${prev.daysInPeriod}, so the totals can't be compared directly.`;
  }
  return null;
}

// ── Comparisons ───────────────────────────────────────────────────────────

/** The client's first training run and first live search run (its first crawl), oldest first. */
async function firstCrawlRuns(clientId: string): Promise<{ id: string; startedAt: Date }[]> {
  const runs = await prisma.run.findMany({
    where: { clientId, status: "COMPLETE" },
    orderBy: { startedAt: "asc" },
    select: { id: true, startedAt: true, rawResponses: { where: { responseText: { not: "" } }, select: { modelId: true }, take: 1 } },
  });
  let training: (typeof runs)[number] | undefined;
  let live: (typeof runs)[number] | undefined;
  for (const run of runs) {
    const first = run.rawResponses[0];
    if (!first) continue; // nothing answered
    if (isLiveSearchModel(first.modelId)) live ??= run;
    else training ??= run;
    if (training && live) break;
  }
  return [training, live]
    .filter((r): r is NonNullable<typeof r> => !!r)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    .map((r) => ({ id: r.id, startedAt: r.startedAt }));
}

/** The Compare With choices for one client, in menu order, with the default first. */
export async function compareChoices(clientId: string) {
  const [benchmarks, firstCrawl] = await Promise.all([
    prisma.benchmarkSnapshot.findMany({
      where: { clientId },
      orderBy: { snapshotDate: "asc" },
      select: { id: true, source: true, snapshotDate: true },
    }),
    firstCrawlRuns(clientId),
  ]);
  return {
    benchmarks: benchmarks.map((b) => ({ id: b.id, label: `${b.source} benchmark (${daysLabel([isoDay(b.snapshotDate)])})` })),
    firstCrawl: firstCrawl.length ? { label: `First crawl (${daysLabel(firstCrawl.map((r) => isoDay(r.startedAt)))})`, days: firstCrawl.map((r) => isoDay(r.startedAt)) } : null,
  };
}

/** The default comparison: the client's first imported benchmark, else its first crawl, else the period before. */
export function defaultCompare(choices: Awaited<ReturnType<typeof compareChoices>>): CompareSpec {
  if (choices.benchmarks[0]) return { kind: "benchmark", snapshotId: choices.benchmarks[0].id };
  if (choices.firstCrawl) return { kind: "firstCrawl" };
  return { kind: "previous" };
}

interface ResolvedCompare {
  info: ReportComparison;
  runs: RunRows; // the comparison's GEO runs (none for an imported benchmark)
  score: CompareScore | null; // set for an imported benchmark (from runs otherwise)
  prompts: Map<string, PromptThen> | null; // set for an imported benchmark (from runs otherwise)
  // An imported benchmark's own figures per platform, when its prompt table has them.
  platformScores?: Map<string, NonNullable<PlatformRow["previous"]>> | null;
}

async function resolveCompare(clientId: string, period: ReportPeriod, spec: CompareSpec): Promise<ResolvedCompare | null> {
  const length = periodDays(period.start, period.end);
  const info = { date: null, source: null, sentimentScore: null, competitors: null };
  const fromRuns = { score: null, prompts: null };

  if (spec.kind === "benchmark") {
    const snap = await prisma.benchmarkSnapshot.findFirst({
      where: { id: spec.snapshotId, clientId },
      include: { competitors: true, prompts: true },
    });
    if (!snap) return null;
    const day = isoDay(snap.snapshotDate);
    const date = daysLabel([day]);
    // Figures the benchmark states itself win; the rest are worked out from its prompt table.
    const fromPrompts = benchmarkPromptFigures(snap.ownVisibilityPct, snap.prompts, {
      rank1Count: snap.ownRank1Count,
      top3Pct: snap.ownTop3Pct,
    });
    const score: CompareScore = {
      checks: null,
      visibilityPct: snap.ownVisibilityPct,
      avgRankWhenFound: snap.ownPosition,
      rank1Count: fromPrompts.rank1Count,
      top3Pct: fromPrompts.top3Pct,
      sentimentPct: snap.ownSentiment, // its 0-100 sentiment score, read as a % (see zeroFillBenchmark)
    };
    // A prompt's rows (one per platform when the benchmark has them): found on
    // any, at its best rank on any, the same way a crawl's prompt is read.
    // Rows per platform also give each engine its own rank then.
    const prompts = new Map<string, PromptThen>();
    for (const p of snap.prompts) {
      const key = promptKey(p.promptText);
      const was = prompts.get(key);
      const found = p.position != null || (p.visibilityPct ?? 0) > 0;
      const ranks = [was?.bestRank, p.position].filter((r): r is number => r != null);
      const byEngine = was?.byEngine ?? (p.platform ? new Map<string, number | null>() : undefined);
      if (byEngine && p.platform) byEngine.set(p.platform, p.position);
      prompts.set(key, { found: !!was?.found || found, bestRank: ranks.length ? Math.min(...ranks) : null, byEngine });
    }
    // Each platform's own figures, from its rows: visibility = answers naming the
    // client / its answers, avg rank = over the answers that named it.
    const platformScores = new Map<string, NonNullable<PlatformRow["previous"]>>();
    for (const platform of new Set(snap.prompts.map((p) => p.platform).filter((x) => x != null))) {
      const rows = snap.prompts.filter((p) => p.platform === platform);
      const ranks = rows.map((p) => p.position).filter((r): r is number => r != null);
      platformScores.set(platform, {
        checks: rows.length,
        visibilityPct: (ranks.length / rows.length) * 100,
        avgRank: ranks.length ? ranks.reduce((a, r) => a + r, 0) / ranks.length : null,
      });
    }
    // Rows measured on another day than the benchmark's, for the notes: MacuMira's
    // "those for 9 prompts are from Jun 1, 2026", "Claude's are from Oct 19, 2026".
    const dateNotes = benchmarkDateGroups(snap.snapshotDate, snap.prompts.filter((p) => p.platform != null)).map((g) =>
      g.platform
        ? `${PLATFORM_LABEL[g.platform] ?? g.platform}'s are from ${daysLabel([isoDay(g.date)])}`
        : `those for ${g.prompts} ${g.prompts === 1 ? "prompt are" : "prompts are"} from ${daysLabel([isoDay(g.date)])}`,
    );
    return {
      info: {
        kind: "benchmark",
        label: `${snap.source} Benchmark`,
        phrase: `the ${snap.source} benchmark (${date})`,
        date,
        period: null,
        trafficPeriod: periodEndingOn(day, length),
        source: snap.source,
        sentimentScore: snap.ownSentiment,
        fromPromptTable: fromPrompts.labels,
        ownSiteCitedPct: snap.ownSiteCitedPct,
        byPlatform: platformScores.size > 0,
        ...(dateNotes.length ? { dateNotes } : {}),
        competitors: [...snap.competitors]
          .sort((a, b) => (b.shareOfVoicePct ?? -1) - (a.shareOfVoicePct ?? -1))
          .map((c) => ({ name: c.name, sharePct: c.shareOfVoicePct, visibilityPct: c.visibilityPct, position: c.position })),
      },
      runs: [],
      score: Object.values(score).some((v) => v != null) ? score : null,
      prompts: prompts.size ? prompts : null,
      platformScores: platformScores.size ? platformScores : null,
    };
  }

  if (spec.kind === "firstCrawl") {
    const first = await firstCrawlRuns(clientId);
    if (!first.length) return null;
    const days = first.map((r) => isoDay(r.startedAt));
    const date = daysLabel(days);
    return {
      ...fromRuns,
      info: {
        ...info,
        kind: "firstCrawl",
        label: "First Crawl",
        phrase: `the first crawl (${date})`,
        date,
        period: makePeriod(days[0], days[days.length - 1]),
        trafficPeriod: periodEndingOn(days[0], length),
      },
      runs: await loadRuns(clientId, { id: { in: first.map((r) => r.id) } }),
    };
  }

  const p = spec.kind === "previous" ? previousPeriod(period.start, period.end) : makePeriod(spec.start, spec.end);
  return {
    ...fromRuns,
    info: { ...info, kind: spec.kind, label: p.label, phrase: p.label, period: p, trafficPeriod: p },
    runs: await loadRuns(clientId, inPeriod(p)),
  };
}

export async function buildMonthlyReportData(
  clientId: string,
  period: ReportPeriod,
  spec: CompareSpec,
  locationKey?: string, // one location's answers only (see onlyLocation); the benchmark is the same for every location
): Promise<MonthlyReportData | "client_not_found" | "compare_not_found"> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, domain: true, brands: { where: { isClientBrand: true }, select: { id: true, name: true }, take: 1 } },
  });
  if (!client) return "client_not_found";
  const compare = await resolveCompare(clientId, period, spec);
  if (!compare) return "compare_not_found";

  const [allCurRuns, curTraffic, prevTraffic, crawl] = await Promise.all([
    loadRuns(clientId, inPeriod(period)),
    trafficTotals(clientId, period),
    compare.info.trafficPeriod ? trafficTotals(clientId, compare.info.trafficPeriod) : null,
    latestCrawlCheck(clientId),
  ]);
  const curRuns = onlyLocation(allCurRuns, locationKey);
  compare.runs = onlyLocation(compare.runs, locationKey);
  const curChecks = curRuns.flatMap((r) => r.rawResponses);
  const prevChecks = compare.runs.flatMap((r) => r.rawResponses);
  const fromRuns = compare.info.kind !== "benchmark";

  // (Imported benchmark gaps in the scorecard become 0 below: zeroFillBenchmark.)
  // An imported benchmark names competitors its own way (often by website): match them to tracked brands.
  // The client's own row compares with the benchmark's own figures (it has no share of voice for the client).
  let benchmark: BenchmarkForRows | null = null;
  if (!fromRuns) {
    const s = compare.score;
    benchmark = {
      list: [],
      matches: new Map(),
      client: s && (s.visibilityPct != null || s.avgRankWhenFound != null)
        ? { position: s.avgRankWhenFound, visibilityPct: s.visibilityPct, sharePct: null }
        : null,
    };
  }
  if (benchmark && compare.info.competitors?.length) {
    const brands = await prisma.brand.findMany({
      where: { clientId },
      select: { id: true, name: true, aliases: { select: { alias: true } } },
    });
    const ownBrand = client.brands[0] ? { key: client.brands[0].id, name: client.brands[0].name } : null;
    const weight = new Map(competitorStats(curChecks, ownBrand).map((s) => [s.key, s.appearances]));
    const matches = matchBenchmarkNames(
      compare.info.competitors.map((c) => c.name),
      brands.map((b) => ({ id: b.id, name: b.name, aliases: b.aliases.map((a) => a.alias) })),
      weight,
    );
    const nameOf = new Map(brands.map((b) => [b.id, b.name]));
    compare.info.competitors = compare.info.competitors.map((c) => ({ ...c, shownAs: nameOf.get(matches.get(c.name) ?? "") ?? null }));
    benchmark = { ...benchmark, list: compare.info.competitors, matches };
  }

  return zeroFillBenchmark({
    period,
    compare: compare.info,
    clientName: client.name,
    domain: client.domain,
    brandName: client.brands[0]?.name ?? null,
    runs: { current: runCounts(curRuns), previous: fromRuns ? runCounts(compare.runs) : null },
    scorecard: {
      current: scoreMetrics(curChecks),
      previous: fromRuns ? (prevChecks.length ? scoreMetrics(prevChecks) : null) : compare.score,
    },
    platforms: fromRuns
      ? platformRows(curChecks, prevChecks)
      : platformRows(curChecks, []).map((p) => ({
          ...p,
          // An imported benchmark with figures per platform: each platform against its own
          // (a platform it didn't cover has none). Otherwise its one all-platform figure for every platform.
          previous: compare.platformScores
            ? (compare.platformScores.get(p.platform) ?? null)
            : compare.score?.visibilityPct != null
              ? { checks: null, visibilityPct: compare.score.visibilityPct, avgRank: compare.score.avgRankWhenFound }
              : null,
        })),
    prompts: promptMoves(curChecks, fromRuns ? (prevChecks.length ? promptsThen(prevChecks) : null) : compare.prompts),
    competitors: competitorRows(
      curChecks,
      fromRuns ? prevChecks : null,
      benchmark,
      client.brands[0] ? { key: client.brands[0].id, name: client.brands[0].name } : null,
    ),
    citations: citationSection(curRuns, compare.runs, siteDomain(client.domain)),
    traffic: curTraffic ? { current: curTraffic, previous: prevTraffic } : null,
    crawl: crawl
      ? {
          checkedAt: crawl.checkedAt.toISOString(),
          url: crawl.url,
          results: crawl.results.map((r) => ({ label: CRAWL_VENDOR_LABEL[r.vendor] ?? r.vendor, success: r.success })),
        }
      : null,
  });
}

/**
 * #1 Rankings and Top-3 Visibility at an imported benchmark. A figure the
 * benchmark states itself is used as stated (MacuMira's Updated GEO
 * Benchmarks: 24 answers at #1, 33.3%). A prompt table with a row per
 * platform (MacuMira's) is one row per answer, so both are counted exactly,
 * the same way as the report's own: answers at #1, and answers in the top 3
 * as a % of all its answers. Otherwise it has one combined row per prompt
 * (Yellowbrick's ISA), and they're worked out from it (the user's call,
 * 2026-11-17, over counting them as 0):
 * - #1 Rankings: its prompts where the client ranked #1 (a prompt count; the
 *   report's own figure counts answers, the closest the benchmark has);
 * - Top-3 Visibility: its overall visibility, scaled by the share of that
 *   visibility from prompts ranked in the top 3 (all of it when every found
 *   prompt ranked top 3, e.g. Yellowbrick's ISA: one prompt, at #1).
 * labels lists only the figures worked out from a combined prompt table.
 * Neither stated nor a prompt table: both stay null (zeroFillBenchmark counts them as 0).
 */
type BenchmarkPromptRow = { platform: string | null; position: number | null; visibilityPct: number | null };

function benchmarkPromptFigures(
  ownVisibilityPct: number | null,
  prompts: BenchmarkPromptRow[],
  stated: { rank1Count: number | null; top3Pct: number | null },
): { rank1Count: number | null; top3Pct: number | null; labels: string[] } {
  const perAnswer = prompts.some((p) => p.platform != null);
  const rows = perAnswer ? prompts.filter((p) => p.platform != null) : prompts;
  const derived = perAnswer
    ? {
        rank1Count: rows.filter((p) => p.position != null && p.position <= 1).length,
        top3Pct: (rows.filter((p) => p.position != null && p.position <= 3).length / rows.length) * 100,
      }
    : deriveFromPromptTable(ownVisibilityPct, rows);
  const labels: string[] = [];
  const rank1Count = stated.rank1Count ?? derived.rank1Count;
  if (!perAnswer && stated.rank1Count == null && derived.rank1Count != null) labels.push("#1 Rankings");
  const top3Pct = stated.top3Pct ?? derived.top3Pct;
  if (!perAnswer && stated.top3Pct == null && derived.top3Pct != null) labels.push("Top-3 Visibility");
  return { rank1Count, top3Pct, labels };
}

function deriveFromPromptTable(
  ownVisibilityPct: number | null,
  prompts: BenchmarkPromptRow[],
): { rank1Count: number | null; top3Pct: number | null } {
  if (!prompts.length) return { rank1Count: null, top3Pct: null };
  const rank1Count = prompts.filter((p) => p.position != null && p.position <= 1).length;
  let top3Pct: number | null = null;
  if (ownVisibilityPct != null) {
    const found = prompts.filter((p) => p.position != null || (p.visibilityPct ?? 0) > 0);
    // Weight each found prompt by its visibility; equally if the table has none.
    const byVisibility = found.some((p) => (p.visibilityPct ?? 0) > 0);
    const weight = (p: (typeof found)[number]) => (byVisibility ? (p.visibilityPct ?? 0) : 1);
    const total = found.reduce((a, p) => a + weight(p), 0);
    const inTop3 = found.filter((p) => p.position != null && p.position <= 3).reduce((a, p) => a + weight(p), 0);
    top3Pct = total > 0 ? (ownVisibilityPct * inTop3) / total : 0;
  }
  return { rank1Count, top3Pct };
}

/**
 * Scorecard figures an imported benchmark didn't report count as 0 there, so
 * every tile has a number to compare with (the user's call, 2026-11-17).
 * Its 0-100 sentiment score is read as a % (85/100 -> 85%, the user's call,
 * 2026-11-17). Avg rank is left alone: 0 isn't a rank. Also applied to saved
 * reports when they're opened (normalizeReportData), so older ones match.
 */
function zeroFillBenchmark(d: MonthlyReportData): MonthlyReportData {
  if (d.compare.kind !== "benchmark") return d;
  const filled: CompareScore = d.scorecard.previous
    ? { ...d.scorecard.previous }
    : { checks: null, visibilityPct: null, avgRankWhenFound: null, rank1Count: null, top3Pct: null, sentimentPct: null };
  if (filled.sentimentPct == null && d.compare.sentimentScore != null) filled.sentimentPct = d.compare.sentimentScore;
  if (d.compare.assumedZero) return { ...d, scorecard: { ...d.scorecard, previous: filled } };
  const assumedZero: string[] = [];
  if (filled.visibilityPct == null) {
    filled.visibilityPct = 0;
    assumedZero.push("Visibility");
  }
  if (filled.rank1Count == null) {
    filled.rank1Count = 0;
    assumedZero.push("#1 Rankings");
  }
  if (filled.top3Pct == null) {
    filled.top3Pct = 0;
    assumedZero.push("Top-3 Visibility");
  }
  if (d.citations && !d.citations.previous && d.compare.ownSiteCitedPct == null) assumedZero.push("Answers Citing Your Site");
  return { ...d, scorecard: { ...d.scorecard, previous: filled }, compare: { ...d.compare, assumedZero } };
}

// ── Key Takeaways ──────────────────────────────────────────────────────────
// Same rules as geo-monthly-report/insights.py: observational, never
// prescriptive, never claims causes, house style (no em dashes, no Oxford
// comma, American English).

const STYLE =
  "Write like an analyst summarizing a performance report for a client who already " +
  "knows their brand and business. State what changed and why it matters, using the real " +
  "numbers given. Do NOT recommend actions, suggest next steps, or use action-plan language " +
  "(no 'should', 'consider', 'recommend', 'needs to') -- describe the result only, not what to " +
  "do about it. State it directly and confidently, as a fact rather than a possibility. Report " +
  "only what the numbers show: never offer a reason a number moved, and never present one metric " +
  "as the cause of another, since the data given does not establish causes. One or " +
  "two sentences, no more than about 40 words total. No preamble, no quotation marks. Do not use " +
  "em dashes (—) anywhere; use a comma, period, or 'and' instead. Do not use an Oxford comma " +
  "in any list. Use American English spelling. Write every percentage with a % sign. " +
  "Respond with the sentence(s) and nothing else.";

// A model narrating its own self-correction into the answer (seen live in
// geo-monthly-report: "... --- Wait, I used 'may' which is hedging. Let me redo.").
const SELF_CORRECTION = /\b(wait,|let me (redo|fix|retry)|---)/i;

async function ask(prompt: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 150, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { content: { type: string; text?: string }[] };
    // The prompt bans em dashes; this is the backstop if one slips through anyway.
    const text = (body.content.find((b) => b.type === "text")?.text ?? "")
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/\s*—\s*/g, ", ");
    if (text && !SELF_CORRECTION.test(text)) return text;
  }
  return null;
}

const r1 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 10) / 10);

export async function writeTakeaways(d: MonthlyReportData, only?: (keyof ReportTakeaways)[]): Promise<ReportTakeaways> {
  const brand = d.brandName ?? d.clientName;
  const c = d.compare;
  const isBenchmark = c.kind === "benchmark";
  const period = `${c.phrase} versus ${d.period.label}`;
  const what = isBenchmark
    ? `\nThe comparison is ${c.phrase}, an earlier audit of ${brand}'s AI visibility.${c.fromPromptTable?.includes("#1 Rankings") ? " The benchmark's rank1_count is the number of its prompts where the brand ranked #1." : ""}${c.assumedZero?.length ? ` The benchmark did not report ${c.assumedZero.join(", ")}, so those count as 0 at the benchmark.` : ""} A null comparison value means that figure was not part of the benchmark.`
    : c.kind === "firstCrawl"
      ? `\nThe comparison is ${c.phrase}, the first tracking of ${brand}'s AI visibility.`
      : "";
  const none = (label: string) => `\nThere is no ${label} data to compare with, so nothing here is a change over time. Never describe a number as rising, falling or improving.`;
  const hasPrev = !!d.scorecard.previous;
  const platformsCompared = d.platforms.some((p) => p.previous);
  const competitorsCompared = d.competitors.some((x) => x.previous);
  const figuresForPrompt = (f: CompetitorFigures | null) =>
    f && { position: r1(f.position), visibility_pct: r1(f.visibilityPct), share_of_voice_pct: r1(f.sharePct) };
  const metrics = (m: CompareScore | null) =>
    m && {
      visibility_pct: r1(m.visibilityPct),
      avg_rank_when_found: r1(m.avgRankWhenFound),
      rank1_count: m.rank1Count,
      top3_visibility_pct: r1(m.top3Pct),
      sentiment_score_pct: r1(m.sentimentPct),
      checks: m.checks,
    };

  // A period with no GEO checks gets no visibility takeaways (nothing to describe).
  const jobs: [keyof ReportTakeaways, string][] = d.scorecard.current.checks === 0 ? [] : [
    [
      "scorecard",
      `${STYLE}\n\nSection: Executive Scorecard\nBrand: ${brand}\nPeriod: ${period}${what}${hasPrev ? "" : none("comparison")}\nData (the comparison, then ${d.period.label}): ${JSON.stringify({ comparison: metrics(d.scorecard.previous), current: metrics(d.scorecard.current) })}\n\nField meanings: visibility_pct = % of AI answers across all tracked prompts and platforms that mentioned the brand. avg_rank_when_found = average list position when mentioned (lower is better). rank1_count = answers where the brand was listed #1. top3_visibility_pct = % of all answers where the brand ranked in the top 3. sentiment_score_pct = % of the brand's mentions that were not negative. checks = AI answers checked.\n\nWrite the Key Takeaway sentence now, referencing the clearest change in the numbers.`,
    ],
    [
      "platforms",
      platformsCompared
        ? `${STYLE}\n\nSection: Visibility by AI Platform\nBrand: ${brand}\nPeriod: ${period}${what}${isBenchmark ? (c.byPlatform ? `\nThe benchmark has its own figures for each platform it covered; a platform with null comparison values was not part of the benchmark, so never describe it as changing.${c.dateNotes?.length ? ` The benchmark's figures are from ${c.date}, except: ${c.dateNotes.join("; ")}.` : ""}` : "\nThe benchmark has one figure for all platforms combined, so it is the comparison for every platform.") : ""}\nPer platform, visibility % and average rank when found, in the comparison then in ${d.period.label}: ${JSON.stringify(
            d.platforms.map((p) => ({
              platform: p.label,
              ...(isBenchmark ? {} : { comparison_answers: p.previous?.checks ?? 0 }),
              current_answers: p.current?.checks ?? 0,
              comparison_visibility_pct: r1(p.previous?.visibilityPct),
              current_visibility_pct: r1(p.current?.visibilityPct),
              comparison_avg_rank: r1(p.previous?.avgRank),
              current_avg_rank: r1(p.current?.avgRank),
            })),
          )}\nanswers = AI answers checked on that platform (0 means it had no answers in that period). A null avg_rank with answers above 0 means the platform answered but never mentioned the brand.\n\nWrite the Key Takeaway sentence now, calling out which platform improved or declined the most.`
        : `${STYLE}\n\nSection: Visibility by AI Platform\nBrand: ${brand}\nPeriod: ${d.period.label}${none("per-platform comparison")}\nPer platform in ${d.period.label}, visibility % and average rank when found: ${JSON.stringify(
            d.platforms.map((p) => ({ platform: p.label, answers: p.current?.checks ?? 0, visibility_pct: r1(p.current?.visibilityPct), avg_rank: r1(p.current?.avgRank) })),
          )}\nanswers = AI answers checked on that platform. A null avg_rank with answers above 0 means the platform answered but never mentioned the brand.\n\nWrite the Key Takeaway sentence now, describing how the platforms differ.`,
    ],
    [
      "prompts",
      d.prompts.compared
        ? `${STYLE}\n\nSection: Prompt Movement\nBrand: ${brand}\nPeriod: ${period}${what}\nPrompts tracked: ${d.prompts.tracked}\nBucket counts: ${JSON.stringify({ new_wins: d.prompts.newWins.length, rank_gains: d.prompts.rankGains.length, other_prompts_led_by_a_competitor: d.prompts.watchlist.length })}\nNew wins (examples): ${JSON.stringify(d.prompts.newWins.slice(0, 5).map((m) => m.text))}\n\nField meanings: "found" means an AI answer mentioned the brand. new_wins = prompts where the brand was not found in the comparison and is found now. rank_gains = prompts where the brand's best rank improved, counting not found as below every rank, so every new win is also a rank gain (never add new_wins and rank_gains together). other_prompts_led_by_a_competitor = further prompts, not counted in new_wins or rank_gains, where the brand is found but a competitor holds the #1 spot. Never describe those as a subset of the new wins.\n\nWrite the Key Takeaway sentence now, summarizing the net movement across these buckets.`
        : `${STYLE}\n\nSection: Prompt Movement\nBrand: ${brand}\nPeriod: ${d.period.label}${none("prompt-level comparison")}\nPrompts tracked: ${d.prompts.tracked}\nPrompts where ${brand} is mentioned but a competitor holds the #1 spot: ${d.prompts.watchlist.length}\nThose prompts with ${brand}'s best rank and the brand most often at #1: ${JSON.stringify(d.prompts.watchlist.slice(0, 8).map((m) => ({ prompt: m.text, best_rank: m.currentBestRank, most_often_first: m.outrankedBy })))}\n\nWrite the Key Takeaway sentence now, describing where ${brand} stands on these prompts in ${d.period.label}.`,
    ],
    [
      "competitors",
      competitorsCompared
        ? `${STYLE}\n\nSection: Competitors\nBrand: ${brand}\nPeriod: ${period}${what}\nEach brand's rank (by mentions in ${d.period.label}), then its average list position (lower is better), visibility % (share of AI answers mentioning it) and Share of Voice % (share of all brand mentions), in the comparison then in ${d.period.label}: ${JSON.stringify(
            d.competitors.map((x) => ({ rank: x.rank, brand: x.name, is_client: x.isClient, comparison: figuresForPrompt(x.previous), current: figuresForPrompt(x.current) })),
          )}\n${isBenchmark ? "The benchmark listed only its top competitors, so a null comparison means the brand was not in that list, not that it had 0%. Never describe such a brand as rising from a specific earlier figure." : "A comparison share of 0 means the brand was not mentioned at all in the comparison."}\n\nWrite the Key Takeaway sentence now, referencing ${brand}'s rank and share relative to whichever competitor moved the most.`
        : `${STYLE}\n\nSection: Competitors\nBrand: ${brand}\nPeriod: ${d.period.label}${none("competitor comparison")}\nEach brand's rank (by mentions), average list position (lower is better), visibility % and Share of Voice % in ${d.period.label}: ${JSON.stringify(
            d.competitors.map((x) => ({ rank: x.rank, brand: x.name, is_client: x.isClient, ...figuresForPrompt(x.current) })),
          )}\n\nWrite the Key Takeaway sentence now, referencing ${brand}'s rank and share relative to the leading brands.`,
    ],
  ];
  if (d.citations) {
    // An imported benchmark has no citation answers, but may have its own-site figure.
    const citingCompared =
      d.citations.previous ?? (c.ownSiteCitedPct != null ? { answers: null, ownSitePct: c.ownSiteCitedPct } : null);
    jobs.push([
      "citations",
      `${STYLE}\n\nSection: AI Citations (the web pages AI answers linked to as sources, from Live Search answers only)\nBrand: ${brand}\nPeriod: ${citingCompared ? period : d.period.label}${citingCompared ? what : none("citation")}\nData: ${JSON.stringify({
        current: { answers: d.citations.current.answers, own_site_cited_pct: r1(d.citations.current.ownSitePct), sites_cited: d.citations.current.sitesCited },
        comparison: citingCompared && { answers: citingCompared.answers, own_site_cited_pct: r1(citingCompared.ownSitePct) },
        top_sites: d.citations.topSites.map((s) => ({ site: s.domain, is_own_site: s.isOwn, share_pct: r1(s.sharePct), comparison_share_pct: r1(s.previousSharePct) })),
      })}\nField meanings: own_site_cited_pct = % of answers that linked to the brand's own website. share_pct = % of answers that cited that site. ${d.citations.previous ? "A null comparison value means there were no Live Search answers in the comparison." : citingCompared ? "The benchmark recorded only how often its answers cited the brand's own site, so the other comparison values are null; never describe other sites as changing." : "A null comparison value means there were no Live Search answers in the comparison."}\n\nWrite the Key Takeaway sentence now, describing how often the brand's own site is cited and which sites AI cites most.`,
    ]);
  }
  if (d.traffic) {
    const t = (x: TrafficTotals | null) =>
      x && {
        ai_assistant_sessions: x.aiAssistant,
        referral_ai_sessions: x.referralAi,
        unassigned_ai_sessions: x.unassignedAi,
        measured_ai_total: x.measuredAiTotal,
        all_sessions: x.sessions,
        days_with_data: x.days,
        days_in_period: x.daysInPeriod,
      };
    const prevLabel = c.trafficPeriod?.label ?? c.label;
    const caveat = trafficCaveat(d.traffic, d.period.label, prevLabel);
    const caveatNote = caveat
      ? `\n${caveat} Never describe a total as rising or falling between the periods. Describe ${d.period.label}'s AI traffic and how many days of data it covers instead.`
      : "";
    const trafficWhat = isBenchmark || c.kind === "firstCrawl" ? `\nThe comparison period is the ${d.traffic.current.daysInPeriod} days up to ${c.phrase}.` : "";
    jobs.push([
      "traffic",
      `${STYLE}\n\nSection: AI Platform Traffic (Google Analytics sessions attributed to AI platforms. This is real site traffic, separate from whether ${brand} was mentioned in AI answers)\nBrand: ${brand}\nPeriod: ${prevLabel} versus ${d.period.label}${trafficWhat}${d.traffic.previous ? "" : none("traffic")}\nData: ${JSON.stringify({ comparison: t(d.traffic.previous), current: t(d.traffic.current) })}\n\nField meanings: ai_assistant_sessions = Google Analytics' own AI Assistant channel. referral_ai_sessions and unassigned_ai_sessions = sessions in those channels whose source names a known AI platform. measured_ai_total = the three added together. all_sessions = every session to the site. Google's AI Overviews are not covered by any of these numbers. Do not claim this is the complete picture of AI traffic.${caveatNote}\n\nWrite the Key Takeaway sentence now, describing what this traffic shows.`,
    ]);
  }

  const wanted = only ? jobs.filter(([k]) => only.includes(k as keyof ReportTakeaways)) : jobs;
  const results = await Promise.all(wanted.map(async ([k, prompt]) => [k, await ask(prompt).catch(() => null)] as const));
  const out: ReportTakeaways = {};
  for (const [k, text] of results) if (text) out[k] = text;
  return out;
}

/** "ISA benchmark (Mar 17, 2026)", "First crawl (Oct 12 – Oct 13, 2026)" or "September 2026", for lists. */
export function compareListLabel(c: ReportComparison): string {
  const s = c.phrase.replace(/^the /, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Generates a report, replacing any saved report for the same period and location (its
 * link stays the same). location: "" = the whole client -- for a client with locations,
 * every location in its own chapter (each with its own figures and takeaways, never
 * blended); a ClientLocation id = that location's answers only; "none" = answers
 * searched with no location.
 */
export async function generateMonthlyReport(
  clientId: string,
  period: ReportPeriod,
  spec: CompareSpec,
  location = "",
): Promise<{ ok: true; id: string } | { ok: false; reason: "client_not_found" | "compare_not_found" | "no_data" | "location_not_found" }> {
  const locations = await prisma.clientLocation.findMany({ where: { clientId }, orderBy: { position: "asc" } });
  const labelOf = (key: string) => (key === "none" ? "No location" : locations.find((l) => l.id === key)?.label);
  if (location && !labelOf(location)) return { ok: false, reason: "location_not_found" };

  let data: MonthlyReportData;
  let takeaways: ReportTakeaways;
  if (location) {
    const one = await buildMonthlyReportData(clientId, period, spec, location);
    if (typeof one === "string") return { ok: false, reason: one };
    data = { ...one, location: { key: location, label: labelOf(location)! } };
    if (data.scorecard.current.checks === 0 && !data.traffic) return { ok: false, reason: "no_data" };
    takeaways = await writeTakeaways(data);
  } else if (locations.length) {
    const whole = await buildMonthlyReportData(clientId, period, spec);
    if (typeof whole === "string") return { ok: false, reason: whole };
    if (whole.scorecard.current.checks === 0 && !whole.traffic) return { ok: false, reason: "no_data" };
    // Every location with answers in the period (plus "No location" when some were searched with none).
    const keys = [...locations.map((l) => l.id), "none"];
    const chapters: LocationReport[] = [];
    for (const key of keys) {
      const one = await buildMonthlyReportData(clientId, period, spec, key);
      if (typeof one === "string") return { ok: false, reason: one };
      if (one.scorecard.current.checks === 0) continue;
      const withLabel = { ...one, location: { key, label: labelOf(key)! } };
      chapters.push({ key, label: labelOf(key)!, data: withLabel, takeaways: await writeTakeaways(withLabel) });
    }
    data = { ...whole, byLocation: chapters };
    takeaways = await writeTakeaways(whole, ["traffic"]);
  } else {
    const one = await buildMonthlyReportData(clientId, period, spec);
    if (typeof one === "string") return { ok: false, reason: one };
    if (one.scorecard.current.checks === 0 && !one.traffic) return { ok: false, reason: "no_data" };
    data = one;
    takeaways = await writeTakeaways(data);
  }
  const fields = { data: data as unknown as object, takeaways, compareLabel: compareListLabel(data.compare) };
  const row = await prisma.monthlyReport.upsert({
    where: { clientId_periodStart_periodEnd_location: { clientId, periodStart: period.start, periodEnd: period.end, location } },
    create: { clientId, periodStart: period.start, periodEnd: period.end, location, ...fields },
    update: fields,
  });
  return { ok: true, id: row.id };
}
