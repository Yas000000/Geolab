import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DateRangePicker } from "@/components/date-range-picker";
import { LocationFilter } from "@/components/location-filter";
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
import { countryName } from "@/lib/client-locations";
import { requireTab } from "@/lib/viewer";

export const dynamic = "force-dynamic";

async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      domain: true,
      // GA4 sessions/active users are still pulled daily but not shown here: the user took
      // them off this page (2026-11-20, "those are just going to confuse people"). Their days
      // still set the All Time fallback and the days a location's chart is zero-filled on.
      // Search Console is also pulled daily but left off, at the user's request (2026-11-19).
      analyticsSnapshots: { orderBy: { date: "asc" }, select: { date: true } },
      aiTrafficSnapshots: { orderBy: { date: "asc" } },
      // Each location's own traffic: GA4 visits from its country (pulled for location countries only).
      locations: { orderBy: { position: "asc" }, select: { id: true, label: true, country: true, city: true } },
      countryTrafficSnapshots: { orderBy: { date: "asc" } },
      // Only the earliest of each -- they define "All Time" (geoAllTimeRange).
      runs: { where: { status: "COMPLETE" }, orderBy: { startedAt: "asc" }, take: 1, select: { startedAt: true } },
      benchmarkSnapshots: { orderBy: { snapshotDate: "asc" }, take: 1, select: { snapshotDate: true } },
    },
  });
}

type ClientData = NonNullable<Awaited<ReturnType<typeof getClient>>>;

type AiField = "aiAssistantSessions" | "referralAiSessions" | "unassignedAiSessions" | "directSessions";

/** One day of the AI traffic breakdown. */
type AiDay = { id: string; date: Date } & Record<AiField, number | null>;

/** The days a view draws from: the whole site, or one location's country. */
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

/**
 * A location's traffic: the property's visits from its country (one row per day has both
 * halves). A day with no visits from there has no row, so every day the whole site has data
 * is filled in with zeros: the charts keep the real timeline instead of joining up the days
 * that had visits (New Zealand has visits on about 1 day in 3).
 */
function countryView(client: ClientData, country: string, range: DateRange | null): TrafficView {
  const rows = client.countryTrafficSnapshots.filter((s) => s.country === country && inDateWindow(s.date, range));
  if (!rows.length) return [];
  const byDay = new Map(rows.map((r) => [r.date.getTime(), r]));
  const siteDays = [...client.analyticsSnapshots, ...client.aiTrafficSnapshots]
    .filter((s) => inDateWindow(s.date, range))
    .map((s) => s.date.getTime());
  const days = [...new Set([...siteDays, ...byDay.keys()])].sort((a, b) => a - b);
  return days.map(
    (t) =>
      byDay.get(t) ?? {
        id: `${country}-${t}`,
        date: new Date(t),
        directSessions: 0,
        aiAssistantSessions: 0,
        referralAiSessions: 0,
        unassignedAiSessions: 0,
      },
  );
}

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function rangeDays(range: DateRange): number {
  return Math.round((dayStart(range.end).getTime() - dayStart(range.start).getTime()) / 86_400_000) + 1;
}

/** Days in the range with any Google Analytics data for the site (a location's days are the site's). */
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
  };
}

const card = "rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950";
const cardLabel = "text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
const sectionTitle = "text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
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

  // Location dropdown (clients tracked in several places): "All locations" shows each
  // location's traffic side by side, then the whole site; one location filters the page to
  // its country. Same entries as the other tabs, minus "No location" (traffic has no such thing).
  const locationParam = typeof sp.location === "string" ? sp.location : "";
  const selected = client.locations.find((l) => l.id === locationParam) ?? null;
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
  const prevOf = (view: (range: DateRange) => TrafficView): Totals | null =>
    comparing && comparisonRange ? totals(view(comparisonRange)) : null;

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
          {client.locations.length > 0 && <LocationFilter locations={client.locations.map((l) => ({ key: l.id, label: l.label }))} />}
          <DateRangePicker allTimeRange={allTimeRange} />
        </div>
      </header>

      {selected && (
        <p className="-mt-3 mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Showing <span className="font-medium text-zinc-900 dark:text-zinc-100">{selected.label}</span> only: visits Google
          Analytics places in {countryName(selected.country)}
          {selected.city ? ` (the whole country; traffic isn't split by city)` : ""}, on every part of the site it tracks.
        </p>
      )}

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
      ) : selected ? (
        <TrafficSections
          view={countryView(client, selected.country, windowRange)}
          prev={prevOf((r) => countryView(client, selected.country, r))}
          where={countryName(selected.country)}
        />
      ) : client.locations.length > 0 ? (
        <>
          <TrafficByLocation
            views={client.locations.map((l) => ({
              key: l.id,
              label: l.label,
              country: l.country,
              city: l.city,
              view: countryView(client, l.country, windowRange),
              prev: prevOf((r) => countryView(client, l.country, r)),
            }))}
          />
          <h2 className="mt-10 mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">Whole Site</h2>
          <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">AI platform visits from every country.</p>
          <TrafficSections view={site} prev={prevOf((r) => wholeSite(client, r))} />
        </>
      ) : (
        <TrafficSections view={site} prev={prevOf((r) => wholeSite(client, r))} />
      )}
    </div>
  );
}

/**
 * All locations: each location's traffic side by side (its country's visits, never
 * added together). Pick a location above for its daily charts.
 */
function TrafficByLocation({
  views,
}: {
  views: { key: string; label: string; country: string; city: string | null; view: TrafficView; prev: Totals | null }[];
}) {
  return (
    <section className="mb-2">
      <h2 className={`mb-3 ${sectionTitle}`}>AI Traffic by Location</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {views.map((v) => {
          const t = totals(v.view);
          const p = v.prev;
          const empty = v.view.length === 0;
          return (
            <div key={v.key} className={`${card} min-w-0`}>
              <div className="mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">{v.label}</div>
              {empty ? (
                <p className="py-4 text-sm text-zinc-500 dark:text-zinc-400">
                  No Google Analytics visits from {countryName(v.country)} in this range
                  {p ? ` (${p.measuredAi.toLocaleString()} measured AI visits in the comparison period)` : ""}.
                </p>
              ) : (
                <>
                  <div className={cardLabel}>Measured AI Visits</div>
                  <div className="mt-1 text-3xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                    {t.measuredAi.toLocaleString()}
                  </div>
                  <Change cur={t.measuredAi} prev={p?.measuredAi} />
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    Visits from {countryName(v.country)}
                    {v.city ? " (whole country)" : ""}
                  </div>
                  <div className="mt-2">
                    <SessionCountSparkline
                      points={v.view.map((s) => ({
                        key: s.id,
                        dateLabel: dateLabel(s.date),
                        value: (s.aiAssistantSessions ?? 0) + (s.referralAiSessions ?? 0) + (s.unassignedAiSessions ?? 0),
                      }))}
                    />
                  </div>
                  <table className="mt-3 w-full text-sm">
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                      <AiRow label="AI Assistant" value={t.aiAssistant} prev={p?.aiAssistant} />
                      <AiRow label="Referral (AI)" value={t.referralAi} prev={p?.referralAi} />
                      <AiRow label="Unassigned (AI)" value={t.unassignedAi} prev={p?.unassignedAi} />
                      <tr>
                        <td className="py-1.5 text-zinc-600 dark:text-zinc-400">
                          Direct{" "}
                          <span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-[9px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                            estimated
                          </span>
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                          ~{t.directAiEstimate.mid.toLocaleString()}
                          <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-400">of {t.direct.toLocaleString()}</span>
                        </td>
                        {p && (
                          <td className="py-1.5 pl-3 text-right text-xs whitespace-nowrap tabular-nums">
                            <Change cur={t.directAiEstimate.mid} prev={p.directAiEstimate.mid} approx inline />
                          </td>
                        )}
                      </tr>
                    </tbody>
                  </table>
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Each location is the visits Google Analytics places in its country, on every part of the site it tracks. Measured AI
        visits = AI Assistant + Referral (AI) + Unassigned (AI). Pick a location above for its daily charts.
      </p>
    </section>
  );
}

function AiRow({ label, value, prev }: { label: string; value: number; prev?: number }) {
  return (
    <tr>
      <td className="py-1.5 text-zinc-600 dark:text-zinc-400">{label}</td>
      <td className="py-1.5 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{value.toLocaleString()}</td>
      {prev != null && (
        <td className="py-1.5 pl-3 text-right text-xs whitespace-nowrap tabular-nums">
          <Change cur={value} prev={prev} inline />
        </td>
      )}
    </tr>
  );
}

/**
 * A total against the "Compare To" period: "was 9 ▲ 3 (+33.3%)". More AI visits reads as
 * good (green). No percentage when the comparison was 0. Nothing without a comparison.
 */
function Change({ cur, prev, approx, inline }: { cur: number; prev: number | null | undefined; approx?: boolean; inline?: boolean }) {
  if (prev == null) return null;
  const d = cur - prev;
  const tone =
    d > 0 ? "text-emerald-600 dark:text-emerald-400" : d < 0 ? "text-red-600 dark:text-red-400" : "text-zinc-400 dark:text-zinc-500";
  const pct = prev > 0 && d !== 0 ? ` (${d > 0 ? "+" : "−"}${Math.abs((d / prev) * 100).toFixed(1)}%)` : "";
  const body = (
    <>
      was {approx ? "~" : ""}
      {prev.toLocaleString()}{" "}
      <span className={`font-medium ${tone}`}>
        {d === 0 ? "no change" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d).toLocaleString()}${inline ? "" : pct}`}
      </span>
    </>
  );
  return inline ? (
    <span className="text-zinc-500 dark:text-zinc-400">{body}</span>
  ) : (
    <div className="mt-0.5 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{body}</div>
  );
}

/** The AI Platform Traffic section, for the whole site or one location's country. */
function TrafficSections({ view, prev: p, where }: { view: TrafficView; prev: Totals | null; where?: string }) {
  const t = totals(view);
  const sparklineForAi = (field: AiField): SessionCountPoint[] =>
    view.map((s) => ({ key: s.id, dateLabel: dateLabel(s.date), value: s[field] ?? 0 }));
  const from = where ? ` from ${where}` : "";

  return (
    <>
      <section>
        <h2 className={`mb-1 ${sectionTitle}`}>AI Platform Traffic</h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          Does not include Google AI Overviews/AI Mode (Organic) -- no reliable way to separate that from regular organic
          search currently exists.
        </p>
        {view.length === 0 ? (
          <div className={emptyBox}>No AI traffic data{from} in this range.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className={card}>
              <div className={cardLabel}>AI Assistant</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                {t.aiAssistant.toLocaleString()}
              </div>
              <Change cur={t.aiAssistant} prev={p?.aiAssistant} />
              <div className="mt-2">
                <SessionCountSparkline points={sparklineForAi("aiAssistantSessions")} />
              </div>
            </div>

            <div className={card}>
              <div className={cardLabel}>Referral (AI)</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                {t.referralAi.toLocaleString()}
              </div>
              <Change cur={t.referralAi} prev={p?.referralAi} />
              <div className="mt-2">
                <SessionCountSparkline points={sparklineForAi("referralAiSessions")} color="#7c3aed" />
              </div>
            </div>

            <div className={card}>
              <div className={cardLabel}>Unassigned (AI)</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                {t.unassignedAi.toLocaleString()}
              </div>
              <Change cur={t.unassignedAi} prev={p?.unassignedAi} />
              <div className="mt-2">
                <SessionCountSparkline points={sparklineForAi("unassignedAiSessions")} color="#d97706" />
              </div>
            </div>

            <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900/40">
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Direct
                <span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  estimated
                </span>
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                ~{t.directAiEstimate.mid.toLocaleString()}
              </div>
              <Change cur={t.directAiEstimate.mid} prev={p?.directAiEstimate.mid} approx />
              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {t.directAiEstimate.low.toLocaleString()}–{t.directAiEstimate.high.toLocaleString()} range (21–47% of{" "}
                {t.direct.toLocaleString()} Direct sessions)
              </div>
              <div className="mt-2">
                <SessionCountSparkline points={sparklineForAi("directSessions")} color="#71717a" />
              </div>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
