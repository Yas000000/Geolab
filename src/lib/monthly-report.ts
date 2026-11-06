import { prisma } from "@/lib/prisma";
import { PLATFORM_LABEL } from "@/lib/geo-platform-map";
import { estimateDirectAiSessions } from "@/lib/ai-traffic";
import { citationTrackedRuns, isLiveSearchModel, siteDomain, summarizeCitations, type CitedAnswer } from "@/lib/citations";
import { CRAWL_VENDOR_LABEL, latestCrawlCheck } from "@/lib/crawl-check";

// The monthly client report: one calendar month vs the month before, from
// this portal's own data (replaces geo-monthly-report's keyword.com CSV
// diffing for portal clients). Months are UTC calendar months.

export interface ScoreMetrics {
  checks: number;
  visibilityPct: number; // % of checks that mentioned the client
  avgRankWhenFound: number | null;
  rank1Count: number; // checks where the client was #1
  top3Pct: number; // % of ALL checks where the client ranked top 3 (same formula as geo-monthly-report)
  sentimentPct: number | null; // % of mentions that weren't negative (same formula as the run page)
}

export interface PlatformRow {
  platform: string;
  label: string;
  current: { checks: number; visibilityPct: number; avgRank: number | null } | null;
  previous: { checks: number; visibilityPct: number; avgRank: number | null } | null;
}

export interface PromptMove {
  text: string;
  previouslyTracked: boolean; // false = no checks of this prompt last month, so "then" is unknown, not "not found"
  previousBestRank: number | null;
  currentBestRank: number | null;
  outrankedBy?: string | null; // the brand most often at #1 when the client wasn't
}

export interface CompetitorRow {
  name: string;
  isClient: boolean;
  currentSovPct: number;
  previousSovPct: number | null; // null = not mentioned at all last month
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
  days: number; // days with Google Analytics data -- below daysInMonth means a partial month
  daysInMonth: number;
}

export interface MonthlyReportData {
  month: string;
  monthLabel: string;
  previousMonth: string;
  previousMonthLabel: string;
  clientName: string;
  domain: string | null;
  brandName: string | null;
  runs: { current: { runs: number; live: number; training: number }; previous: { runs: number; live: number; training: number } };
  scorecard: { current: ScoreMetrics; previous: ScoreMetrics | null };
  platforms: PlatformRow[];
  prompts: { tracked: number; newWins: PromptMove[]; rankGains: PromptMove[]; watchlist: PromptMove[] };
  competitors: CompetitorRow[];
  citations: CitationSection | null;
  traffic: { current: TrafficTotals; previous: TrafficTotals | null } | null;
  crawl: { checkedAt: string; url: string; results: { label: string; success: boolean }[] } | null;
}

export type ReportTakeaways = Partial<Record<"scorecard" | "platforms" | "prompts" | "competitors" | "citations" | "traffic", string>>;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(month: string): boolean {
  return MONTH_RE.test(month);
}

export function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  return monthBounds(month).start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The most recent full calendar month (UTC) -- the default report month. */
export function lastCompleteMonth(now = new Date()): string {
  return shiftMonth(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`, -1);
}

async function loadRuns(clientId: string, start: Date, end: Date) {
  return prisma.run.findMany({
    where: { clientId, status: "COMPLETE", startedAt: { gte: start, lt: end } },
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

type RunRows = Awaited<ReturnType<typeof loadRuns>>;
type Check = RunRows[number]["rawResponses"][number];

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);

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

function runCounts(runs: RunRows) {
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

function promptMoves(current: Check[], previous: Check[]) {
  interface Acc { text: string; checks: Check[] }
  const group = (checks: Check[]) => {
    const m = new Map<string, Acc>();
    for (const c of checks) {
      const key = c.prompt.text.trim().toLowerCase();
      const a = m.get(key) ?? { text: c.prompt.text, checks: [] };
      a.checks.push(c);
      m.set(key, a);
    }
    return m;
  };
  const bestRank = (checks: Check[]) => {
    const ranks = checks
      .filter((c) => c.parsedResult?.clientBrandMentioned)
      .map((c) => c.parsedResult?.clientBrandRank)
      .filter((r): r is number => r != null);
    return ranks.length ? Math.min(...ranks) : null;
  };
  const found = (checks: Check[]) => checks.some((c) => c.parsedResult?.clientBrandMentioned);
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

  const cur = group(current);
  const prev = group(previous);
  const newWins: PromptMove[] = [];
  const rankGains: PromptMove[] = [];
  const watchlist: PromptMove[] = [];
  for (const [key, a] of cur) {
    const p = prev.get(key);
    const currentBestRank = bestRank(a.checks);
    const previousBestRank = p ? bestRank(p.checks) : null;
    const move = { text: a.text, previouslyTracked: !!p, previousBestRank, currentBestRank };
    // A prompt with no checks last month is new to tracking, not a win.
    if (p && !found(p.checks) && found(a.checks)) newWins.push(move);
    else if (p && found(p.checks) && currentBestRank != null && previousBestRank != null && currentBestRank < previousBestRank)
      rankGains.push(move);
    else if (found(a.checks) && currentBestRank != null && currentBestRank > 1)
      watchlist.push({ ...move, outrankedBy: leader(a.checks) });
  }
  const byRank = (x: PromptMove, y: PromptMove) => (x.currentBestRank ?? 99) - (y.currentBestRank ?? 99) || x.text.localeCompare(y.text);
  return { tracked: cur.size, newWins: newWins.sort(byRank), rankGains: rankGains.sort(byRank), watchlist: watchlist.sort(byRank) };
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

async function trafficTotals(clientId: string, start: Date, end: Date): Promise<TrafficTotals | null> {
  const where = { clientId, date: { gte: start, lt: end } };
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
    daysInMonth: Math.round((end.getTime() - start.getTime()) / 86_400_000),
  };
}

/** True when either month's Google Analytics data is missing days, so totals can't be compared as-is. */
export function trafficIsPartial(traffic: { current: TrafficTotals; previous: TrafficTotals | null }): boolean {
  const partial = (t: TrafficTotals | null) => !!t && t.days < t.daysInMonth;
  return partial(traffic.current) || partial(traffic.previous);
}

export async function buildMonthlyReportData(clientId: string, month: string): Promise<MonthlyReportData | null> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, domain: true, brands: { where: { isClientBrand: true }, select: { name: true }, take: 1 } },
  });
  if (!client) return null;

  const prevMonth = shiftMonth(month, -1);
  const cur = monthBounds(month);
  const prev = monthBounds(prevMonth);
  const [curRuns, prevRuns, curTraffic, prevTraffic, crawl] = await Promise.all([
    loadRuns(clientId, cur.start, cur.end),
    loadRuns(clientId, prev.start, prev.end),
    trafficTotals(clientId, cur.start, cur.end),
    trafficTotals(clientId, prev.start, prev.end),
    latestCrawlCheck(clientId),
  ]);
  const curChecks = curRuns.flatMap((r) => r.rawResponses);
  const prevChecks = prevRuns.flatMap((r) => r.rawResponses);

  return {
    month,
    monthLabel: monthLabel(month),
    previousMonth: prevMonth,
    previousMonthLabel: monthLabel(prevMonth),
    clientName: client.name,
    domain: client.domain,
    brandName: client.brands[0]?.name ?? null,
    runs: { current: runCounts(curRuns), previous: runCounts(prevRuns) },
    scorecard: { current: scoreMetrics(curChecks), previous: prevChecks.length ? scoreMetrics(prevChecks) : null },
    platforms: platformRows(curChecks, prevChecks),
    prompts: promptMoves(curChecks, prevChecks),
    competitors: competitorRows(curChecks, prevChecks),
    citations: citationSection(curRuns, prevRuns, siteDomain(client.domain)),
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
  "Write like an analyst summarizing a monthly performance report for a client who already " +
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
  const period = `${d.previousMonthLabel} versus ${d.monthLabel}`;
  const hasPrev = !!d.scorecard.previous;
  const prevNote = hasPrev
    ? ""
    : `\nThere is no data for ${d.previousMonthLabel}, so nothing here is a change over time. Never describe a number as rising, falling or improving.`;
  const metrics = (m: ScoreMetrics | null) =>
    m && {
      visibility_pct: r1(m.visibilityPct),
      avg_rank_when_found: r1(m.avgRankWhenFound),
      rank1_count: m.rank1Count,
      top3_visibility_pct: r1(m.top3Pct),
      sentiment_score_pct: r1(m.sentimentPct),
      checks: m.checks,
    };

  // A month with no GEO checks gets no visibility takeaways (nothing to describe).
  const jobs: [keyof ReportTakeaways, string][] = d.scorecard.current.checks === 0 ? [] : [
    [
      "scorecard",
      `${STYLE}\n\nSection: Executive Scorecard\nBrand: ${brand}\nPeriod: ${period}${prevNote}\nData (previous month, then this month): ${JSON.stringify({ previous: metrics(d.scorecard.previous), current: metrics(d.scorecard.current) })}\n\nField meanings: visibility_pct = % of AI answers across all tracked prompts and platforms that mentioned the brand. avg_rank_when_found = average list position when mentioned (lower is better). rank1_count = answers where the brand was listed #1. top3_visibility_pct = % of all answers where the brand ranked in the top 3. sentiment_score_pct = % of the brand's mentions that were not negative. checks = AI answers checked.\n\nWrite the Key Takeaway sentence now, referencing the clearest change in the numbers.`,
    ],
    [
      "platforms",
      `${STYLE}\n\nSection: Visibility by AI Platform\nBrand: ${brand}\nPeriod: ${period}${prevNote}\nPer platform, visibility % and average rank when found, previous month then this month: ${JSON.stringify(
        d.platforms.map((p) => ({
          platform: p.label,
          previous_visibility_pct: r1(p.previous?.visibilityPct),
          current_visibility_pct: r1(p.current?.visibilityPct),
          previous_avg_rank: r1(p.previous?.avgRank),
          current_avg_rank: r1(p.current?.avgRank),
        })),
      )}\nA null value means that platform had no answers that month.\n\nWrite the Key Takeaway sentence now, calling out which platform improved or declined the most.`,
    ],
    [
      "prompts",
      hasPrev
        ? `${STYLE}\n\nSection: Prompt Movement\nBrand: ${brand}\nPeriod: ${period}\nPrompts tracked: ${d.prompts.tracked}\nBucket counts: ${JSON.stringify({ new_wins: d.prompts.newWins.length, rank_gains: d.prompts.rankGains.length, watchlist: d.prompts.watchlist.length })}\nNew wins (examples): ${JSON.stringify(d.prompts.newWins.slice(0, 5).map((m) => m.text))}\n\nField meanings: "found" means an AI answer mentioned the brand. new_wins = prompts where the brand was not found last month and is found now. rank_gains = prompts where the brand was found in both months and its best rank improved. watchlist = prompts where the brand is found but a competitor holds the #1 spot.\n\nWrite the Key Takeaway sentence now, summarizing the net movement across these buckets.`
        : `${STYLE}\n\nSection: Prompt Movement\nBrand: ${brand}\nMonth: ${d.monthLabel}${prevNote}\nPrompts tracked: ${d.prompts.tracked}\nPrompts where ${brand} is mentioned but a competitor holds the #1 spot: ${d.prompts.watchlist.length}\nThose prompts with ${brand}'s best rank and the brand most often at #1: ${JSON.stringify(d.prompts.watchlist.slice(0, 8).map((m) => ({ prompt: m.text, best_rank: m.currentBestRank, most_often_first: m.outrankedBy })))}\n\nWrite the Key Takeaway sentence now, describing where ${brand} stands on these prompts this month.`,
    ],
    [
      "competitors",
      `${STYLE}\n\nSection: Competitor Share of Voice\nBrand: ${brand}\nPeriod: ${period}${prevNote}\nShare of Voice (% of all brand mentions in AI answers), previous month then this month: ${JSON.stringify(
        d.competitors.map((c) => ({ brand: c.name, is_client: c.isClient, previous_pct: r1(c.previousSovPct), current_pct: r1(c.currentSovPct) })),
      )}\nA null previous value means the brand was not mentioned at all last month, so never describe it as a rise from a specific earlier figure.\n\nWrite the Key Takeaway sentence now, referencing ${brand}'s share relative to whichever competitor moved the most.`,
    ],
  ];
  if (d.citations) {
    jobs.push([
      "citations",
      `${STYLE}\n\nSection: AI Citations (the web pages AI answers linked to as sources, from Live Search answers only)\nBrand: ${brand}\nPeriod: ${period}\nData: ${JSON.stringify({
        current: { answers: d.citations.current.answers, own_site_cited_pct: r1(d.citations.current.ownSitePct), sites_cited: d.citations.current.sitesCited },
        previous: d.citations.previous && { answers: d.citations.previous.answers, own_site_cited_pct: r1(d.citations.previous.ownSitePct) },
        top_sites: d.citations.topSites.map((s) => ({ site: s.domain, is_own_site: s.isOwn, share_pct: r1(s.sharePct), previous_share_pct: r1(s.previousSharePct) })),
      })}\nField meanings: own_site_cited_pct = % of answers that linked to the brand's own website. share_pct = % of answers that cited that site. A null previous value means there were no Live Search answers last month, so nothing is a change over time.\n\nWrite the Key Takeaway sentence now, describing how often the brand's own site is cited and which sites AI cites most.`,
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
        days_in_month: x.daysInMonth,
      };
    const partialNote = trafficIsPartial(d.traffic)
      ? "\nAt least one month is missing days of data (compare days_with_data with days_in_month), so the monthly totals are not comparable. Never describe a total as rising or falling between the months. Describe this month's AI traffic and how many days of data it covers instead."
      : "";
    jobs.push([
      "traffic",
      `${STYLE}\n\nSection: AI Platform Traffic (Google Analytics sessions attributed to AI platforms. This is real site traffic, separate from whether ${brand} was mentioned in AI answers)\nBrand: ${brand}\nPeriod: ${period}\nData: ${JSON.stringify({ previous: t(d.traffic.previous), current: t(d.traffic.current) })}\n\nField meanings: ai_assistant_sessions = Google Analytics' own AI Assistant channel. referral_ai_sessions and unassigned_ai_sessions = sessions in those channels whose source names a known AI platform. measured_ai_total = the three added together. all_sessions = every session to the site. Google's AI Overviews are not covered by any of these numbers. Do not claim this is the complete picture of AI traffic.${partialNote}\n\nWrite the Key Takeaway sentence now, describing what this traffic shows.`,
    ]);
  }

  const results = await Promise.all(jobs.map(async ([k, prompt]) => [k, await ask(prompt).catch(() => null)] as const));
  const out: ReportTakeaways = {};
  for (const [k, text] of results) if (text) out[k] = text;
  return out;
}

export async function generateMonthlyReport(
  clientId: string,
  month: string,
): Promise<{ ok: true; id: string; month: string } | { ok: false; reason: "client_not_found" | "no_data" }> {
  const data = await buildMonthlyReportData(clientId, month);
  if (!data) return { ok: false, reason: "client_not_found" };
  if (data.scorecard.current.checks === 0 && !data.traffic) return { ok: false, reason: "no_data" };
  const takeaways = await writeTakeaways(data);
  const row = await prisma.monthlyReport.upsert({
    where: { clientId_month: { clientId, month } },
    create: { clientId, month, data: data as unknown as object, takeaways },
    update: { data: data as unknown as object, takeaways },
  });
  return { ok: true, id: row.id, month: row.month };
}

/** Months (UTC, "YYYY-MM") that have at least one complete run, newest first. */
export async function monthsWithRuns(clientId: string): Promise<string[]> {
  const runs = await prisma.run.findMany({ where: { clientId, status: "COMPLETE" }, select: { startedAt: true } });
  const months = new Set(runs.map((r) => `${r.startedAt.getUTCFullYear()}-${String(r.startedAt.getUTCMonth() + 1).padStart(2, "0")}`));
  return [...months].sort().reverse();
}
