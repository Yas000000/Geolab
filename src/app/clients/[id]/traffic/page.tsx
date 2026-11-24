import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DateRangePicker } from "@/components/date-range-picker";
import { SessionCountSparkline, type SessionCountPoint } from "@/components/session-count-sparkline";
import {
  formatDisplayDate,
  geoAllTimeRange,
  parseISODate,
  resolveComparisonRange,
  type CompareMode,
  type DateRange,
} from "@/lib/date-range";
import { estimateDirectAiSessions } from "@/lib/ai-traffic";
import { requireTab } from "@/lib/viewer";
import { InfoNote } from "@/components/info-note";

export const dynamic = "force-dynamic";

async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      domain: true,
      // Settings switch for the AI Conversions section below the AI traffic boxes.
      showAiConversions: true,
      // GA4 sessions/active users are still pulled daily but not shown here: the user took
      // them off this page (2026-11-20, "those are just going to confuse people"). Their days
      // still set the All Time fallback and count as days with data in comparisons.
      // Search Console is also pulled daily but left off, at the user's request (2026-11-19).
      analyticsSnapshots: { orderBy: { date: "asc" }, select: { date: true } },
      aiTrafficSnapshots: { orderBy: { date: "asc" } },
      // No location split on this tab: the user took it off (2026-11-20). Country traffic is
      // still pulled daily for clients with locations, for their reports.
      // Only the earliest of each -- they define "All Time" (geoAllTimeRange).
      runs: { where: { status: "COMPLETE" }, orderBy: { startedAt: "asc" }, take: 1, select: { startedAt: true } },
      benchmarkSnapshots: { orderBy: { snapshotDate: "asc" }, take: 1, select: { snapshotDate: true } },
    },
  });
}

type ClientData = NonNullable<Awaited<ReturnType<typeof getClient>>>;

type AiField = "aiAssistantSessions" | "referralAiSessions" | "unassignedAiSessions" | "directSessions";

/** One day of the AI traffic breakdown (and its AI Conversions figures, null until pulled). */
type AiDay = ClientData["aiTrafficSnapshots"][number];

/** The days the page draws from. */
type TrafficView = AiDay[];

function inDateWindow(date: Date, range: DateRange | null): boolean {
  if (!range) return true;
  const endExclusive = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 1);
  return date.getTime() >= range.start.getTime() && date.getTime() < endExclusive.getTime();
}

function dateLabel(d: Date) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function wholeSite(client: ClientData, range: DateRange | null): TrafficView {
  return client.aiTrafficSnapshots.filter((s) => inDateWindow(s.date, range));
}

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function rangeDays(range: DateRange): number {
  return Math.round((dayStart(range.end).getTime() - dayStart(range.start).getTime()) / 86_400_000) + 1;
}

/** Days in the range with any Google Analytics data for the site. */
function siteDaysWithData(client: ClientData, range: DateRange): number {
  return new Set(
    [...client.analyticsSnapshots, ...client.aiTrafficSnapshots].filter((s) => inDateWindow(s.date, range)).map((s) => s.date.getTime()),
  ).size;
}

type Totals = ReturnType<typeof totals>;

function totals(view: TrafficView) {
  const sumAi = (field: AiField) => view.reduce((acc, s) => acc + (s[field] ?? 0), 0);
  const aiAssistant = sumAi("aiAssistantSessions");
  const referralAi = sumAi("referralAiSessions");
  const unassignedAi = sumAi("unassignedAiSessions");
  const direct = sumAi("directSessions");
  return {
    aiAssistant,
    referralAi,
    unassignedAi,
    measuredAi: aiAssistant + referralAi + unassignedAi,
    direct,
    directAiEstimate: estimateDirectAiSessions(direct),
    conversions: conversionTotals(view),
  };
}

/**
 * The AI Conversions figures for a range, from the days they've been pulled for (a day
 * before the first pull has null conversion fields and is left out of every figure here,
 * visits included, so the rates compare like with like).
 */
function conversionTotals(view: TrafficView) {
  const days = view.filter((d) => d.aiAssistantKeyEvents != null);
  const sum = (f: (d: AiDay) => number | null) => days.reduce((acc, d) => acc + (f(d) ?? 0), 0);
  const byName = new Map<string, number>();
  for (const d of days) {
    const names = d.aiKeyEventsByName as Record<string, number> | null;
    for (const [name, n] of Object.entries(names ?? {})) byName.set(name, (byName.get(name) ?? 0) + n);
  }
  const aiAssistant = sum((d) => d.aiAssistantKeyEvents);
  const referralAi = sum((d) => d.referralAiKeyEvents);
  const unassignedAi = sum((d) => d.unassignedAiKeyEvents);
  return {
    days: days.length,
    aiAssistant,
    referralAi,
    unassignedAi,
    inAiVisits: aiAssistant + referralAi + unassignedAi,
    aiVisits: sum((d) => (d.aiAssistantSessions ?? 0) + (d.referralAiSessions ?? 0) + (d.unassignedAiSessions ?? 0)),
    aiEngaged: sum((d) => (d.aiAssistantEngagedSessions ?? 0) + (d.referralAiEngagedSessions ?? 0) + (d.unassignedAiEngagedSessions ?? 0)),
    introduced: sum((d) => d.aiIntroducedKeyEvents),
    siteSessions: sum((d) => d.siteSessions),
    siteKeyEvents: sum((d) => d.siteKeyEvents),
    siteEngaged: sum((d) => d.siteEngagedSessions),
    byName: [...byName.entries()].sort((a, b) => b[1] - a[1]),
  };
}

type ConversionTotals = ReturnType<typeof conversionTotals>;

/** n of d as a percentage with one decimal, or null when there's nothing to divide by. */
const pctOf = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);
// "<0.1%" for a rate that's above 0 but rounds to 0.0 (Golden: 3 key events in 1.8M visits).
const fmtPct = (v: number | null) => (v == null ? "n/a" : v > 0 && v < 0.05 ? "<0.1%" : `${v.toFixed(1)}%`);

const sectionTitle = "text-sm font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-500";
const emptyBox =
  "rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400";

export default async function ClientTrafficPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const viewer = await requireTab(id, "traffic");
  const sp = await searchParams;
  const startParam = typeof sp.start === "string" ? sp.start : undefined;
  const endParam = typeof sp.end === "string" ? sp.end : undefined;
  const dateRange: DateRange | null =
    startParam && endParam ? { start: parseISODate(startParam), end: parseISODate(endParam) } : null;

  const client = await getClient(id);
  if (!client) notFound();

  // "All Time" = the same span as the Rankings page: from the client's first
  // GEO data point (first complete run or imported benchmark) to today --
  // and unlike Rankings it actually has to filter by it, since GA4 history
  // can reach back years before GEO tracking began (Yellowbrick: 2022 vs
  // Mar 2026). Older traffic stays reachable via a custom range. A client
  // with no GEO data yet falls back to its full traffic span. Snapshot
  // `date` fields are UTC-midnight date-only values, so that fallback
  // truncates in UTC terms.
  const utcCalendarDay = (d: Date) => new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
  const trafficStarts = [
    ...client.analyticsSnapshots.map((s) => utcCalendarDay(s.date)),
    ...client.aiTrafficSnapshots.map((s) => utcCalendarDay(s.date)),
  ];
  const allTimeSpan: DateRange | null =
    geoAllTimeRange(
      client.runs.map((r) => r.startedAt),
      client.benchmarkSnapshots.map((b) => b.snapshotDate),
    ) ?? (trafficStarts.length ? { start: new Date(Math.min(...trafficStarts)), end: new Date() } : null);
  // Whole days (geoAllTimeRange already is; the no-GEO-data fallback ends "now"): otherwise
  // "Compare To: Last Period" on All Time comes out a day longer than the period it's compared with.
  const allTimeRange: DateRange | null = allTimeSpan && { start: dayStart(allTimeSpan.start), end: dayStart(allTimeSpan.end) };
  const windowRange = dateRange ?? allTimeRange;

  const site = wholeSite(client, windowRange);
  const noSiteData = site.length === 0;

  // "Compare To" in the date picker. Resolved against the range this page shows (All Time
  // included), the same dates the picker prints under itself as "vs. ...". A comparison period
  // with no Google Analytics data at all has nothing to compare with, so no changes are shown.
  const compareMode = (typeof sp.compare === "string" ? sp.compare : "none") as CompareMode;
  const compareStartParam = typeof sp.compareStart === "string" ? sp.compareStart : undefined;
  const compareEndParam = typeof sp.compareEnd === "string" ? sp.compareEnd : undefined;
  const customCompareRange: DateRange | null =
    compareStartParam && compareEndParam ? { start: parseISODate(compareStartParam), end: parseISODate(compareEndParam) } : null;
  const resolvedCompare = resolveComparisonRange(windowRange, compareMode, customCompareRange);
  const comparisonRange: DateRange | null = resolvedCompare && { start: dayStart(resolvedCompare.start), end: dayStart(resolvedCompare.end) };
  const coverage =
    comparisonRange && windowRange
      ? {
          cur: { data: siteDaysWithData(client, windowRange), days: rangeDays(windowRange) },
          prev: { data: siteDaysWithData(client, comparisonRange), days: rangeDays(comparisonRange) },
        }
      : null;
  const comparing = !!coverage && coverage.prev.data > 0 && !!comparisonRange;
  const prev: Totals | null = comparing && comparisonRange ? totals(wholeSite(client, comparisonRange)) : null;

  const notConnected =
    viewer.role === "TEAM" ? (
      <>
        No analytics data in this range yet — connect a Google account in{" "}
        <a href={`/clients/${id}/settings`} className="underline">
          Settings
        </a>{" "}
        and the daily pull will populate this.
      </>
    ) : (
      "No analytics data in this range yet."
    );

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}</h1>
          {client.domain && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <DateRangePicker allTimeRange={allTimeRange} />
        </div>
      </header>

      {!noSiteData && coverage && comparisonRange && (
        <p className="-mt-3 mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          {comparing ? (
            <>
              Changes are vs. {formatDisplayDate(comparisonRange.start)} – {formatDisplayDate(comparisonRange.end)}.
              {coverage.cur.data !== coverage.prev.data && (
                <span className="text-amber-700 dark:text-amber-400">
                  {" "}
                  Google Analytics data covers {coverage.cur.data} of {coverage.cur.days} days in this period and{" "}
                  {coverage.prev.data} of {coverage.prev.days} in the comparison
                  {coverage.cur.data < coverage.cur.days ? " (each day's data arrives the next day)" : ""}, so the totals
                  aren&apos;t like for like.
                </span>
              )}
            </>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">
              No Google Analytics data for {formatDisplayDate(comparisonRange.start)} – {formatDisplayDate(comparisonRange.end)},
              so there&apos;s nothing to compare with.
            </span>
          )}
        </p>
      )}

      {noSiteData ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          {notConnected}
        </div>
      ) : (
        <TrafficSections view={site} prev={prev} showConversions={client.showAiConversions} />
      )}
    </div>
  );
}

/**
 * A total against the "Compare To" period: "was 9 ▲ 3 (+33.3%)". More AI visits reads as
 * good (green). No percentage when the comparison was 0. Nothing without a comparison.
 */
function Change({ cur, prev, approx }: { cur: number; prev: number | null | undefined; approx?: boolean }) {
  if (prev == null) return null;
  const d = cur - prev;
  const tone =
    d > 0 ? "text-emerald-600 dark:text-emerald-400" : d < 0 ? "text-red-600 dark:text-red-400" : "text-zinc-400 dark:text-zinc-500";
  const pct = prev > 0 && d !== 0 ? ` (${d > 0 ? "+" : "−"}${Math.abs((d / prev) * 100).toFixed(1)}%)` : "";
  return (
    <div className="mt-0.5 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
      was {approx ? "~" : ""}
      {prev.toLocaleString()}{" "}
      <span className={`font-medium ${tone}`}>
        {d === 0 ? "no change" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d).toLocaleString()}${pct}`}
      </span>
    </div>
  );
}

/** The AI Platform Traffic section (the whole site, every country), then AI Conversions when switched on. */
function TrafficSections({ view, prev: p, showConversions }: { view: TrafficView; prev: Totals | null; showConversions: boolean }) {
  const t = totals(view);
  const sparklineForAi = (field: AiField): SessionCountPoint[] =>
    view.map((s) => ({ key: s.id, dateLabel: dateLabel(s.date), value: s[field] ?? 0 }));

  return (
    <>
      <section>
        <h2 className={`mb-1 ${sectionTitle}`}>AI Platform Traffic</h2>
        <InfoNote className="mb-4">
          Doesn&apos;t include Google&apos;s AI Overviews or AI Mode: Google counts those visits as ordinary organic search,
          and there&apos;s no reliable way to separate them.
        </InfoNote>
        {view.length === 0 ? (
          <div className={emptyBox}>No AI traffic data in this range.</div>
        ) : (
          // Two per row, each with what it counts (user, 2026-11-20: four across was too small).
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <AiCard
              label="AI Assistant"
              description="Visits Google Analytics puts in its own AI Assistant channel: people clicking a link in an AI chat assistant such as ChatGPT or Gemini."
              value={t.aiAssistant.toLocaleString()}
              change={<Change cur={t.aiAssistant} prev={p?.aiAssistant} />}
              chart={<SessionCountSparkline points={sparklineForAi("aiAssistantSessions")} height={150} />}
            />
            <AiCard
              label="Referral (AI)"
              description="Visits Google Analytics files as referrals from an AI platform its AI Assistant channel doesn't recognize, such as Perplexity."
              value={t.referralAi.toLocaleString()}
              change={<Change cur={t.referralAi} prev={p?.referralAi} />}
              chart={<SessionCountSparkline points={sparklineForAi("referralAiSessions")} color="#7c3aed" height={150} />}
            />
            <AiCard
              label="Unassigned (AI)"
              description="Visits Google Analytics couldn't place in any channel, but whose tracking tags name an AI platform."
              value={t.unassignedAi.toLocaleString()}
              change={<Change cur={t.unassignedAi} prev={p?.unassignedAi} />}
              chart={<SessionCountSparkline points={sparklineForAi("unassignedAiSessions")} color="#d97706" height={150} />}
            />
            <AiCard
              estimated
              label="Direct"
              description="Visits that arrive with no record of where they came from. AI apps often open links this way, so some of these came from AI but can't be measured. Research puts 21% to 47% of Direct visits as AI-referred; the figure shown uses the middle of that range and is an estimate, not a measurement."
              value={`~${t.directAiEstimate.mid.toLocaleString()}`}
              change={<Change cur={t.directAiEstimate.mid} prev={p?.directAiEstimate.mid} approx />}
              note={`${t.directAiEstimate.low.toLocaleString()} to ${t.directAiEstimate.high.toLocaleString()} of ${t.direct.toLocaleString()} Direct visits. The chart shows all Direct visits per day.`}
              chart={<SessionCountSparkline points={sparklineForAi("directSessions")} color="#71717a" height={150} />}
            />
          </div>
        )}
      </section>
      {showConversions && <AiConversionsSection c={t.conversions} prev={p?.conversions ?? null} />}
    </>
  );
}

/**
 * AI Conversions (Settings switch, 2026-11-23): key events from the three measured AI
 * sources, key events by people who first came from AI, and how engaged AI visits were,
 * each against the whole site and the Compare To period.
 */
function AiConversionsSection({ c, prev }: { c: ConversionTotals; prev: ConversionTotals | null }) {
  const p = prev && prev.days > 0 ? prev : null;
  const aiRate = pctOf(c.inAiVisits, c.aiVisits);
  const siteRate = pctOf(c.siteKeyEvents, c.siteSessions);
  const aiEngagement = pctOf(c.aiEngaged, c.aiVisits);
  const siteEngagement = pctOf(c.siteEngaged, c.siteSessions);
  return (
    <section className="mt-8">
      <h2 className={`mb-1 ${sectionTitle}`}>AI Conversions</h2>
      <InfoNote className="mb-4">
        Conversions are the key events set up in this client&apos;s Google Analytics, such as form submits and calls. They come
        from the three measured AI sources above; Direct visits can&apos;t be told apart, so they aren&apos;t included. Google
        Analytics only counts an event as a key event from the day it was marked as one.
      </InfoNote>
      {c.days === 0 ? (
        <div className={emptyBox}>Conversion data for this range hasn&apos;t been pulled yet.</div>
      ) : (
        <>
          {c.siteKeyEvents === 0 && (
            <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Google Analytics recorded no key events anywhere on this site in this range, so there are no conversions to credit
              to AI. Check that this client&apos;s key events are set up and firing in Google Analytics.
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <ConversionCard
              label="From AI visits"
              description="Key events that happened during a visit from an AI platform."
              value={c.inAiVisits.toLocaleString()}
              change={<Change cur={c.inAiVisits} prev={p?.inAiVisits} />}
            >
              <div>
                {fmtPct(aiRate)} of {c.aiVisits.toLocaleString()} AI visits; site average {fmtPct(siteRate)}
              </div>
              <div>
                AI Assistant {c.aiAssistant.toLocaleString()} · Referral (AI) {c.referralAi.toLocaleString()} · Unassigned (AI){" "}
                {c.unassignedAi.toLocaleString()}
              </div>
              {c.byName.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {c.byName.map(([name, n]) => (
                    <li key={name} className="flex justify-between gap-3">
                      <span className="min-w-0 break-words">{name.replace(/_/g, " ")}</span>
                      <span className="tabular-nums">{n.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </ConversionCard>
            <ConversionCard
              label="AI-introduced"
              description="Key events by people whose first visit came from an AI platform, counted when they converted, even on a later visit that came another way."
              value={c.introduced.toLocaleString()}
              change={<Change cur={c.introduced} prev={p?.introduced} />}
            />
            <ConversionCard
              label="AI visit engagement"
              description="Share of AI visits Google Analytics counts as engaged: 10 seconds or longer, two or more pages, or a key event."
              value={fmtPct(aiEngagement)}
              change={<ChangePts cur={aiEngagement} prev={p ? pctOf(p.aiEngaged, p.aiVisits) : null} />}
            >
              <div>
                {c.aiEngaged.toLocaleString()} of {c.aiVisits.toLocaleString()} AI visits; site average {fmtPct(siteEngagement)}
              </div>
            </ConversionCard>
          </div>
        </>
      )}
    </section>
  );
}

/** A percentage against the Compare To period, in points: "was 48.0% ▲ 4.2 pts". */
function ChangePts({ cur, prev }: { cur: number | null; prev: number | null }) {
  if (cur == null || prev == null) return null;
  const d = Math.round((cur - prev) * 10) / 10;
  const tone =
    d > 0 ? "text-emerald-600 dark:text-emerald-400" : d < 0 ? "text-red-600 dark:text-red-400" : "text-zinc-400 dark:text-zinc-500";
  return (
    <div className="mt-0.5 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
      was {prev.toFixed(1)}%{" "}
      <span className={`font-medium ${tone}`}>{d === 0 ? "no change" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)} pts`}</span>
    </div>
  );
}

/** One AI Conversions box: what it counts, its figure, its change and any detail lines. */
function ConversionCard({
  label,
  description,
  value,
  change,
  children,
}: {
  label: string;
  description: string;
  value: string;
  change: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300">{label}</div>
      <p className="mt-1 text-sm leading-snug text-zinc-500 dark:text-zinc-400">{description}</p>
      <div className="mt-3 text-4xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">{value}</div>
      {change}
      {children && <div className="mt-2 space-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">{children}</div>}
    </div>
  );
}

/** One of the four AI Platform Traffic boxes: what it counts, its total, its change and its daily chart. */
function AiCard({
  label,
  description,
  value,
  change,
  note,
  chart,
  estimated,
}: {
  label: string;
  description: string;
  value: string;
  change: React.ReactNode;
  note?: string;
  chart: React.ReactNode;
  estimated?: boolean;
}) {
  return (
    <div
      className={
        estimated
          ? "min-w-0 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-5 py-4 dark:border-zinc-700 dark:bg-zinc-900/40"
          : "min-w-0 rounded-lg border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950"
      }
    >
      <div className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300">
        {label}
        {estimated && (
          <span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            estimated
          </span>
        )}
      </div>
      <p className="mt-1 text-sm leading-snug text-zinc-500 dark:text-zinc-400">{description}</p>
      <div className="mt-3 text-4xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">{value}</div>
      {change}
      {note && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{note}</div>}
      <div className="mt-3">{chart}</div>
    </div>
  );
}
