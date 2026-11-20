import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DateRangePicker } from "@/components/date-range-picker";
import { LocationFilter } from "@/components/location-filter";
import { SessionCountSparkline, type SessionCountPoint } from "@/components/session-count-sparkline";
import { geoAllTimeRange, parseISODate, type DateRange } from "@/lib/date-range";
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
      analyticsSnapshots: { orderBy: { date: "asc" } },
      // Search Console is still pulled daily (Settings picks the site) but is left off
      // this page for now, at the user's request (2026-11-19).
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

/** One day of GA4 totals. */
interface Ga4Day {
  id: string;
  date: Date;
  sessions: number | null;
  activeUsers: number | null;
}

type AiField = "aiAssistantSessions" | "referralAiSessions" | "unassignedAiSessions" | "directSessions";

/** One day of the AI traffic breakdown. */
type AiDay = { id: string; date: Date } & Record<AiField, number | null>;

/** The days a view draws from: the whole site, or one location's country. */
interface TrafficView {
  ga4: Ga4Day[];
  ai: AiDay[];
}

function inDateWindow(date: Date, range: DateRange | null): boolean {
  if (!range) return true;
  const endExclusive = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 1);
  return date.getTime() >= range.start.getTime() && date.getTime() < endExclusive.getTime();
}

function dateLabel(d: Date) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function wholeSite(client: ClientData, range: DateRange | null): TrafficView {
  return {
    ga4: client.analyticsSnapshots.filter((s) => inDateWindow(s.date, range)),
    ai: client.aiTrafficSnapshots.filter((s) => inDateWindow(s.date, range)),
  };
}

/**
 * A location's traffic: the property's visits from its country (one row per day has both
 * halves). A day with no visits from there has no row, so every day the whole site has data
 * is filled in with zeros: the charts keep the real timeline instead of joining up the days
 * that had visits (New Zealand has visits on about 1 day in 3).
 */
function countryView(client: ClientData, country: string, range: DateRange | null): TrafficView {
  const rows = client.countryTrafficSnapshots.filter((s) => s.country === country && inDateWindow(s.date, range));
  if (!rows.length) return { ga4: [], ai: [] };
  const byDay = new Map(rows.map((r) => [r.date.getTime(), r]));
  const days = [
    ...new Set([...client.analyticsSnapshots.filter((s) => inDateWindow(s.date, range)).map((s) => s.date.getTime()), ...byDay.keys()]),
  ].sort((a, b) => a - b);
  const filled: (Ga4Day & AiDay)[] = days.map(
    (t) =>
      byDay.get(t) ?? {
        id: `${country}-${t}`,
        date: new Date(t),
        sessions: 0,
        activeUsers: 0,
        directSessions: 0,
        aiAssistantSessions: 0,
        referralAiSessions: 0,
        unassignedAiSessions: 0,
      },
  );
  return { ga4: filled, ai: filled };
}

function totals(view: TrafficView) {
  const sumGa4 = (field: "sessions" | "activeUsers") => view.ga4.reduce((acc, s) => acc + (s[field] ?? 0), 0);
  const sumAi = (field: AiField) => view.ai.reduce((acc, s) => acc + (s[field] ?? 0), 0);
  const aiAssistant = sumAi("aiAssistantSessions");
  const referralAi = sumAi("referralAiSessions");
  const unassignedAi = sumAi("unassignedAiSessions");
  const direct = sumAi("directSessions");
  return {
    sessions: sumGa4("sessions"),
    activeUsers: sumGa4("activeUsers"),
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
  const allTimeRange: DateRange | null =
    geoAllTimeRange(
      client.runs.map((r) => r.startedAt),
      client.benchmarkSnapshots.map((b) => b.snapshotDate),
    ) ?? (trafficStarts.length ? { start: new Date(Math.min(...trafficStarts)), end: new Date() } : null);
  const windowRange = dateRange ?? allTimeRange;

  // Location dropdown (clients tracked in several places): "All locations" shows each
  // location's traffic side by side, then the whole site; one location filters the page to
  // its country. Same entries as the other tabs, minus "No location" (traffic has no such thing).
  const locationParam = typeof sp.location === "string" ? sp.location : "";
  const selected = client.locations.find((l) => l.id === locationParam) ?? null;
  const site = wholeSite(client, windowRange);
  const noSiteData = site.ga4.length === 0 && site.ai.length === 0;

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

      {noSiteData ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          {notConnected}
        </div>
      ) : selected ? (
        <TrafficSections view={countryView(client, selected.country, windowRange)} where={countryName(selected.country)} />
      ) : client.locations.length > 0 ? (
        <>
          <TrafficByLocation
            views={client.locations.map((l) => ({
              key: l.id,
              label: l.label,
              country: l.country,
              city: l.city,
              view: countryView(client, l.country, windowRange),
            }))}
          />
          <h2 className="mt-10 mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">Whole Site</h2>
          <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">Every visit, from every country.</p>
          <TrafficSections view={site} />
        </>
      ) : (
        <TrafficSections view={site} />
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
  views: { key: string; label: string; country: string; city: string | null; view: TrafficView }[];
}) {
  return (
    <section className="mb-2">
      <h2 className={`mb-3 ${sectionTitle}`}>Traffic by Location</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {views.map((v) => {
          const t = totals(v.view);
          const empty = v.view.ga4.length === 0;
          return (
            <div key={v.key} className={`${card} min-w-0`}>
              <div className="mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">{v.label}</div>
              {empty ? (
                <p className="py-4 text-sm text-zinc-500 dark:text-zinc-400">
                  No Google Analytics visits from {countryName(v.country)} in this range.
                </p>
              ) : (
                <>
                  <div className={cardLabel}>Sessions</div>
                  <div className="mt-1 text-3xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                    {t.sessions.toLocaleString()}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {t.activeUsers.toLocaleString()} active users · visits from {countryName(v.country)}
                    {v.city ? " (whole country)" : ""}
                  </div>
                  <div className="mt-2">
                    <SessionCountSparkline
                      points={v.view.ga4.map((s) => ({ key: s.id, dateLabel: dateLabel(s.date), value: s.sessions ?? 0 }))}
                    />
                  </div>
                  <table className="mt-3 w-full text-sm">
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                      <AiRow label="AI Assistant" value={t.aiAssistant} />
                      <AiRow label="Referral (AI)" value={t.referralAi} />
                      <AiRow label="Unassigned (AI)" value={t.unassignedAi} />
                      <AiRow label="Measured AI visits" value={t.measuredAi} strong />
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

function AiRow({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <tr>
      <td className={`py-1.5 ${strong ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}`}>{label}</td>
      <td className={`py-1.5 text-right tabular-nums ${strong ? "font-semibold" : ""} text-zinc-900 dark:text-zinc-100`}>
        {value.toLocaleString()}
      </td>
    </tr>
  );
}

/** The Google Analytics and AI Platform Traffic sections, for the whole site or one location's country. */
function TrafficSections({ view, where }: { view: TrafficView; where?: string }) {
  const t = totals(view);
  const trend = (field: "sessions" | "activeUsers"): SessionCountPoint[] =>
    view.ga4.map((s) => ({ key: s.id, dateLabel: dateLabel(s.date), value: s[field] ?? 0 }));
  const sparklineForAi = (field: AiField): SessionCountPoint[] =>
    view.ai.map((s) => ({ key: s.id, dateLabel: dateLabel(s.date), value: s[field] ?? 0 }));
  const from = where ? ` from ${where}` : "";

  return (
    <>
      <section className="mb-8">
        <h2 className={`mb-3 ${sectionTitle}`}>Google Analytics</h2>
        {view.ga4.length === 0 ? (
          <div className={emptyBox}>No GA4 data{from} in this range.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className={card}>
              <div className={cardLabel}>Sessions</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">{t.sessions.toLocaleString()}</div>
              <div className="mt-2">
                <SessionCountSparkline points={trend("sessions")} />
              </div>
            </div>
            <div className={card}>
              <div className={cardLabel}>Active Users</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                {t.activeUsers.toLocaleString()}
              </div>
              <div className="mt-2">
                <SessionCountSparkline points={trend("activeUsers")} color="#2563eb" />
              </div>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className={`mb-1 ${sectionTitle}`}>AI Platform Traffic</h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          Does not include Google AI Overviews/AI Mode (Organic) -- no reliable way to separate that from regular organic
          search currently exists.
        </p>
        {view.ai.length === 0 ? (
          <div className={emptyBox}>No AI traffic data{from} in this range.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className={card}>
              <div className={cardLabel}>AI Assistant</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                {t.aiAssistant.toLocaleString()}
              </div>
              <div className="mt-2">
                <SessionCountSparkline points={sparklineForAi("aiAssistantSessions")} />
              </div>
            </div>

            <div className={card}>
              <div className={cardLabel}>Referral (AI)</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                {t.referralAi.toLocaleString()}
              </div>
              <div className="mt-2">
                <SessionCountSparkline points={sparklineForAi("referralAiSessions")} color="#7c3aed" />
              </div>
            </div>

            <div className={card}>
              <div className={cardLabel}>Unassigned (AI)</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                {t.unassignedAi.toLocaleString()}
              </div>
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
