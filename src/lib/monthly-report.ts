import { prisma } from "@/lib/prisma";
import { PLATFORM_LABEL } from "@/lib/geo-platform-map";
import { estimateDirectAiSessions } from "@/lib/ai-traffic";
import { citationTrackedRuns, isLiveSearchModel, siteDomain, summarizeCitations, type CitedAnswer } from "@/lib/citations";
import { CRAWL_VENDOR_LABEL, latestCrawlCheck } from "@/lib/crawl-check";
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
  previous: { checks: number; visibilityPct: number; avgRank: number | null } | null;
}

export interface PromptMove {
  text: string;
  previouslyTracked: boolean; // false = not in the comparison, so "then" is unknown, not "not found"
  previousBestRank: number | null;
  currentBestRank: number | null;
  outrankedBy?: string | null; // the brand most often at #1 when the client wasn't
}

export interface CompetitorRow {
  name: string;
  isClient: boolean;
  currentSovPct: number;
  previousSovPct: number | null; // null = not mentioned at all in the comparison
  currentVisibilityPct: number;
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
}

export interface ReportComparison {
  kind: CompareSpec["kind"];
  label: string; // short, for column headers: "ISA Benchmark", "First Crawl", "September 2026"
  phrase: string; // inside sentences: "the ISA benchmark (Mar 17, 2026)", "September 2026"
  date: string | null; // when the benchmark or first crawl was taken, e.g. "Mar 17, 2026"
  period: ReportPeriod | null; // the days of GEO runs compared (null for an imported benchmark)
  trafficPeriod: ReportPeriod | null; // the Google Analytics days compared
  source: string | null; // an imported benchmark's source, e.g. "ISA"
  sentimentScore: number | null; // an imported benchmark's own 0-100 sentiment: a different scale, never compared
  competitors: BenchmarkCompetitorRow[] | null; // an imported benchmark's competitor table
}

export interface RunCounts {
  runs: number;
  live: number;
  training: number;
}

export interface MonthlyReportData {
  period: ReportPeriod;
  compare: ReportComparison;
  clientName: string;
  domain: string | null;
  brandName: string | null;
  runs: { current: RunCounts; previous: RunCounts | null };
  scorecard: { current: ScoreMetrics; previous: CompareScore | null };
  platforms: PlatformRow[];
  prompts: { tracked: number; compared: boolean; newWins: PromptMove[]; rankGains: PromptMove[]; watchlist: PromptMove[] };
  competitors: CompetitorRow[];
  citations: CitationSection | null;
  traffic: { current: TrafficTotals; previous: TrafficTotals | null } | null;
  crawl: { checkedAt: string; url: string; results: { label: string; success: boolean }[] } | null;
}

export type ReportTakeaways = Partial<Record<"scorecard" | "platforms" | "prompts" | "competitors" | "citations" | "traffic", string>>;

/**
 * Reports saved before custom periods (2026-11-17) stored one month against
 * the month before, with month/monthLabel/previousMonth fields. Maps them to
 * the current shape so they still open.
 */
type LegacyTraffic = Omit<TrafficTotals, "daysInPeriod"> & { daysInMonth: number };
type LegacyReport = Omit<MonthlyReportData, "period" | "compare" | "prompts" | "traffic"> & {
  month: string;
  previousMonth: string;
  prompts: Omit<MonthlyReportData["prompts"], "compared">;
  traffic: { current: LegacyTraffic; previous: LegacyTraffic | null } | null;
};

export function normalizeReportData(raw: unknown): MonthlyReportData {
  if ((raw as MonthlyReportData).period) return raw as MonthlyReportData;
  const { month, previousMonth, ...r } = raw as LegacyReport;
  const period = monthPeriod(month);
  const prev = monthPeriod(previousMonth);
  const fix = ({ daysInMonth, ...t }: LegacyTraffic): TrafficTotals => ({ ...t, daysInPeriod: daysInMonth });
  return {
    ...r,
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
          modelId: true,
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
  for (const [key, a] of groupByPrompt(checks)) out.set(key, { found: found(a.checks), bestRank: bestRank(a.checks) });
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
  const newWins: PromptMove[] = [];
  const rankGains: PromptMove[] = [];
  const watchlist: PromptMove[] = [];
  for (const [key, a] of cur) {
    const p = then?.get(key);
    const currentBestRank = bestRank(a.checks);
    const previousBestRank = p?.bestRank ?? null;
    const move = { text: a.text, previouslyTracked: !!p, previousBestRank, currentBestRank };
    // A prompt that isn't in the comparison is new to tracking, not a win.
    if (p && !p.found && found(a.checks)) newWins.push(move);
    else if (p && p.found && currentBestRank != null && previousBestRank != null && currentBestRank < previousBestRank)
      rankGains.push(move);
    else if (found(a.checks) && currentBestRank != null && currentBestRank > 1)
      watchlist.push({ ...move, outrankedBy: leader(a.checks) });
  }
  const byRank = (x: PromptMove, y: PromptMove) => (x.currentBestRank ?? 99) - (y.currentBestRank ?? 99) || x.text.localeCompare(y.text);
  return {
    tracked: cur.size,
    compared: !!then && then.size > 0,
    newWins: newWins.sort(byRank),
    rankGains: rankGains.sort(byRank),
    watchlist: watchlist.sort(byRank),
  };
}

function competitorRows(current: Check[], previous: Check[]): CompetitorRow[] {
  const tally = (checks: Check[]) => {
    const mentions = new Map<string, { name: string; isClient: boolean; count: number; checks: Set<Check> }>();
    let total = 0;
    for (const c of checks) {
      for (const m of c.parsedResult?.mentions ?? []) {
        const key = m.brand?.id ?? `raw:${m.rawLabel.toLowerCase()}`;
        const e = mentions.get(key) ?? { name: m.brand?.name ?? m.rawLabel, isClient: !!m.brand?.isClientBrand, count: 0, checks: new Set() };
        e.count += 1;
        e.checks.add(c);
        mentions.set(key, e);
        total += 1;
      }
    }
    return { mentions, total };
  };
  const cur = tally(current);
  const prev = tally(previous);
  const rows = [...cur.mentions.entries()]
    .map(([key, e]) => {
      const p = prev.mentions.get(key);
      return {
        name: e.name,
        isClient: e.isClient,
        currentSovPct: pct(e.count, cur.total),
        previousSovPct: p ? pct(p.count, prev.total) : null,
        currentVisibilityPct: pct(e.checks.size, current.length),
      };
    })
    .sort((a, b) => b.currentSovPct - a.currentSovPct);
  const top = rows.slice(0, 10);
  const client = rows.find((r) => r.isClient);
  if (client && !top.includes(client)) top.push(client);
  return top;
}

function citationSection(current: RunRows, previous: RunRows, ownDomain: string | null): CitationSection | null {
  const toAnswers = (runs: RunRows): CitedAnswer[] =>
    citationTrackedRuns(runs)
      .flatMap((run) => run.rawResponses)
      .filter((c) => isLiveSearchModel(c.modelId))
      .map((c) => ({ platform: c.platform, promptText: c.prompt.text, promptCategory: c.prompt.category, citations: c.citations }));
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
    const score: CompareScore = {
      checks: null,
      visibilityPct: snap.ownVisibilityPct,
      avgRankWhenFound: snap.ownPosition,
      rank1Count: null,
      top3Pct: null,
      sentimentPct: null, // the benchmark's sentiment is a 0-100 score, not "% of mentions not negative"
    };
    const prompts = new Map<string, PromptThen>();
    for (const p of snap.prompts) {
      prompts.set(promptKey(p.promptText), { found: p.position != null || (p.visibilityPct ?? 0) > 0, bestRank: p.position });
    }
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
        competitors: [...snap.competitors]
          .sort((a, b) => (b.shareOfVoicePct ?? -1) - (a.shareOfVoicePct ?? -1))
          .map((c) => ({ name: c.name, sharePct: c.shareOfVoicePct, visibilityPct: c.visibilityPct, position: c.position })),
      },
      runs: [],
      score: Object.values(score).some((v) => v != null) ? score : null,
      prompts: prompts.size ? prompts : null,
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
): Promise<MonthlyReportData | "client_not_found" | "compare_not_found"> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, domain: true, brands: { where: { isClientBrand: true }, select: { name: true }, take: 1 } },
  });
  if (!client) return "client_not_found";
  const compare = await resolveCompare(clientId, period, spec);
  if (!compare) return "compare_not_found";

  const [curRuns, curTraffic, prevTraffic, crawl] = await Promise.all([
    loadRuns(clientId, inPeriod(period)),
    trafficTotals(clientId, period),
    compare.info.trafficPeriod ? trafficTotals(clientId, compare.info.trafficPeriod) : null,
    latestCrawlCheck(clientId),
  ]);
  const curChecks = curRuns.flatMap((r) => r.rawResponses);
  const prevChecks = compare.runs.flatMap((r) => r.rawResponses);
  const fromRuns = compare.info.kind !== "benchmark";

  return {
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
    platforms: platformRows(curChecks, prevChecks),
    prompts: promptMoves(curChecks, fromRuns ? (prevChecks.length ? promptsThen(prevChecks) : null) : compare.prompts),
    competitors: competitorRows(curChecks, prevChecks),
    citations: citationSection(curRuns, compare.runs, siteDomain(client.domain)),
    traffic: curTraffic ? { current: curTraffic, previous: prevTraffic } : null,
    crawl: crawl
      ? {
          checkedAt: crawl.checkedAt.toISOString(),
          url: crawl.url,
          results: crawl.results.map((r) => ({ label: CRAWL_VENDOR_LABEL[r.vendor] ?? r.vendor, success: r.success })),
        }
      : null,
  };
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

export async function writeTakeaways(d: MonthlyReportData): Promise<ReportTakeaways> {
  const brand = d.brandName ?? d.clientName;
  const c = d.compare;
  const isBenchmark = c.kind === "benchmark";
  const period = `${c.phrase} versus ${d.period.label}`;
  const what = isBenchmark
    ? `\nThe comparison is ${c.phrase}, an earlier audit of ${brand}'s AI visibility. A null comparison value means that figure was not part of the benchmark.`
    : c.kind === "firstCrawl"
      ? `\nThe comparison is ${c.phrase}, the first tracking of ${brand}'s AI visibility.`
      : "";
  const none = (label: string) => `\nThere is no ${label} data to compare with, so nothing here is a change over time. Never describe a number as rising, falling or improving.`;
  const hasPrev = !!d.scorecard.previous;
  const runsCompared = !isBenchmark && hasPrev;
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
      runsCompared
        ? `${STYLE}\n\nSection: Visibility by AI Platform\nBrand: ${brand}\nPeriod: ${period}${what}\nPer platform, visibility % and average rank when found, in the comparison then in ${d.period.label}: ${JSON.stringify(
            d.platforms.map((p) => ({
              platform: p.label,
              comparison_answers: p.previous?.checks ?? 0,
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
        ? `${STYLE}\n\nSection: Prompt Movement\nBrand: ${brand}\nPeriod: ${period}${what}\nPrompts tracked: ${d.prompts.tracked}\nBucket counts: ${JSON.stringify({ new_wins: d.prompts.newWins.length, rank_gains: d.prompts.rankGains.length, other_prompts_led_by_a_competitor: d.prompts.watchlist.length })}\nNew wins (examples): ${JSON.stringify(d.prompts.newWins.slice(0, 5).map((m) => m.text))}\n\nField meanings: "found" means an AI answer mentioned the brand. new_wins = prompts where the brand was not found in the comparison and is found now. rank_gains = prompts where the brand was found in both and its best rank improved. other_prompts_led_by_a_competitor = further prompts, not counted in new_wins or rank_gains, where the brand is found but a competitor holds the #1 spot. Never describe those as a subset of the new wins.\n\nWrite the Key Takeaway sentence now, summarizing the net movement across these buckets.`
        : `${STYLE}\n\nSection: Prompt Movement\nBrand: ${brand}\nPeriod: ${d.period.label}${none("prompt-level comparison")}\nPrompts tracked: ${d.prompts.tracked}\nPrompts where ${brand} is mentioned but a competitor holds the #1 spot: ${d.prompts.watchlist.length}\nThose prompts with ${brand}'s best rank and the brand most often at #1: ${JSON.stringify(d.prompts.watchlist.slice(0, 8).map((m) => ({ prompt: m.text, best_rank: m.currentBestRank, most_often_first: m.outrankedBy })))}\n\nWrite the Key Takeaway sentence now, describing where ${brand} stands on these prompts in ${d.period.label}.`,
    ],
    [
      "competitors",
      runsCompared
        ? `${STYLE}\n\nSection: Competitor Share of Voice\nBrand: ${brand}\nPeriod: ${period}${what}\nShare of Voice (% of all brand mentions in AI answers), in the comparison then in ${d.period.label}: ${JSON.stringify(
            d.competitors.map((x) => ({ brand: x.name, is_client: x.isClient, comparison_pct: r1(x.previousSovPct), current_pct: r1(x.currentSovPct) })),
          )}\nA null comparison value means the brand was not mentioned at all in the comparison, so never describe it as a rise from a specific earlier figure.\n\nWrite the Key Takeaway sentence now, referencing ${brand}'s share relative to whichever competitor moved the most.`
        : `${STYLE}\n\nSection: Competitor Share of Voice\nBrand: ${brand}\nPeriod: ${d.period.label}${none("Share of Voice comparison")}\nShare of Voice (% of all brand mentions in AI answers) in ${d.period.label}: ${JSON.stringify(
            d.competitors.map((x) => ({ brand: x.name, is_client: x.isClient, pct: r1(x.currentSovPct) })),
          )}\n\nWrite the Key Takeaway sentence now, referencing ${brand}'s share relative to the leading brands.`,
    ],
  ];
  if (d.citations) {
    jobs.push([
      "citations",
      `${STYLE}\n\nSection: AI Citations (the web pages AI answers linked to as sources, from Live Search answers only)\nBrand: ${brand}\nPeriod: ${d.citations.previous ? period : d.period.label}${d.citations.previous ? what : none("citation")}\nData: ${JSON.stringify({
        current: { answers: d.citations.current.answers, own_site_cited_pct: r1(d.citations.current.ownSitePct), sites_cited: d.citations.current.sitesCited },
        comparison: d.citations.previous && { answers: d.citations.previous.answers, own_site_cited_pct: r1(d.citations.previous.ownSitePct) },
        top_sites: d.citations.topSites.map((s) => ({ site: s.domain, is_own_site: s.isOwn, share_pct: r1(s.sharePct), comparison_share_pct: r1(s.previousSharePct) })),
      })}\nField meanings: own_site_cited_pct = % of answers that linked to the brand's own website. share_pct = % of answers that cited that site. A null comparison value means there were no Live Search answers in the comparison.\n\nWrite the Key Takeaway sentence now, describing how often the brand's own site is cited and which sites AI cites most.`,
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

  const results = await Promise.all(jobs.map(async ([k, prompt]) => [k, await ask(prompt).catch(() => null)] as const));
  const out: ReportTakeaways = {};
  for (const [k, text] of results) if (text) out[k] = text;
  return out;
}

/** "ISA benchmark (Mar 17, 2026)", "First crawl (Oct 12 – Oct 13, 2026)" or "September 2026", for lists. */
export function compareListLabel(c: ReportComparison): string {
  const s = c.phrase.replace(/^the /, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Generates a report, replacing any saved report for the same period (its link stays the same). */
export async function generateMonthlyReport(
  clientId: string,
  period: ReportPeriod,
  spec: CompareSpec,
): Promise<{ ok: true; id: string } | { ok: false; reason: "client_not_found" | "compare_not_found" | "no_data" }> {
  const data = await buildMonthlyReportData(clientId, period, spec);
  if (typeof data === "string") return { ok: false, reason: data };
  if (data.scorecard.current.checks === 0 && !data.traffic) return { ok: false, reason: "no_data" };
  const takeaways = await writeTakeaways(data);
  const fields = { data: data as unknown as object, takeaways, compareLabel: compareListLabel(data.compare) };
  const row = await prisma.monthlyReport.upsert({
    where: { clientId_periodStart_periodEnd: { clientId, periodStart: period.start, periodEnd: period.end } },
    create: { clientId, periodStart: period.start, periodEnd: period.end, ...fields },
    update: fields,
  });
  return { ok: true, id: row.id };
}
