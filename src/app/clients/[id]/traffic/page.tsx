import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DateRangePicker } from "@/components/date-range-picker";
import { SessionCountSparkline, type SessionCountPoint } from "@/components/session-count-sparkline";
import { parseISODate, type DateRange } from "@/lib/date-range";
import { estimateDirectAiSessions } from "@/lib/ai-traffic";

export const dynamic = "force-dynamic";

async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      domain: true,
      analyticsSnapshots: { orderBy: { date: "asc" } },
      searchConsoleSnapshots: { orderBy: { date: "asc" } },
      aiTrafficSnapshots: { orderBy: { date: "asc" } },
    },
  });
}

type ClientData = NonNullable<Awaited<ReturnType<typeof getClient>>>;

function inDateWindow(date: Date, range: DateRange | null): boolean {
  if (!range) return true;
  const endExclusive = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 1);
  return date.getTime() >= range.start.getTime() && date.getTime() < endExclusive.getTime();
}

function dateLabel(d: Date) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default async function ClientTrafficPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const startParam = typeof sp.start === "string" ? sp.start : undefined;
  const endParam = typeof sp.end === "string" ? sp.end : undefined;
  const dateRange: DateRange | null =
    startParam && endParam ? { start: parseISODate(startParam), end: parseISODate(endParam) } : null;

  const client = await getClient(id);
  if (!client) notFound();

  // Full unbounded span (ignores the active date filter) -- used only to show
  // real dates under the picker's "All Time" option, never for filtering.
  // These snapshot `date` fields are UTC-midnight date-only values (one row
  // per client per day), so truncate in UTC terms -- same fix as the
  // benchmark snapshotDate's own display, see rankings/page.tsx for the
  // mixed-semantics version of this same note.
  const utcCalendarDay = (d: Date) => new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
  const allTimeStarts = [
    ...client.analyticsSnapshots.map((s) => utcCalendarDay(s.date)),
    ...client.searchConsoleSnapshots.map((s) => utcCalendarDay(s.date)),
    ...client.aiTrafficSnapshots.map((s) => utcCalendarDay(s.date)),
  ];
  const allTimeRange: DateRange | null = allTimeStarts.length
    ? { start: new Date(Math.min(...allTimeStarts)), end: new Date() }
    : null;

  const ga4InRange = client.analyticsSnapshots.filter((s) => inDateWindow(s.date, dateRange));
  const gscInRange = client.searchConsoleSnapshots.filter((s) => inDateWindow(s.date, dateRange));
  const aiInRange = client.aiTrafficSnapshots.filter((s) => inDateWindow(s.date, dateRange));

  const sumGa4 = (field: "sessions" | "activeUsers" | "keyEvents") =>
    ga4InRange.reduce((acc, s) => acc + (s[field] ?? 0), 0);
  const sumGsc = (field: "clicks" | "impressions") => gscInRange.reduce((acc, s) => acc + (s[field] ?? 0), 0);
  const avgGsc = (field: "ctr" | "avgPosition") => {
    const vals = gscInRange.map((s) => s[field]).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null;
  };

  const sessions = sumGa4("sessions");
  const activeUsers = sumGa4("activeUsers");
  const clicks = sumGsc("clicks");
  const impressions = sumGsc("impressions");
  const avgCtr = avgGsc("ctr");
  const avgPosition = avgGsc("avgPosition");

  const sessionsTrend: SessionCountPoint[] = ga4InRange.map((s) => ({
    key: s.id,
    dateLabel: dateLabel(s.date),
    value: s.sessions ?? 0,
  }));
  const usersTrend: SessionCountPoint[] = ga4InRange.map((s) => ({
    key: s.id,
    dateLabel: dateLabel(s.date),
    value: s.activeUsers ?? 0,
  }));
  const clicksTrend: SessionCountPoint[] = gscInRange.map((s) => ({
    key: s.id,
    dateLabel: dateLabel(s.date),
    value: s.clicks ?? 0,
  }));
  const impressionsTrend: SessionCountPoint[] = gscInRange.map((s) => ({
    key: s.id,
    dateLabel: dateLabel(s.date),
    value: s.impressions ?? 0,
  }));

  const sumAi = (field: "aiAssistantSessions" | "referralAiSessions" | "unassignedAiSessions" | "directSessions") =>
    aiInRange.reduce((acc, s) => acc + (s[field] ?? 0), 0);
  const aiAssistantTotal = sumAi("aiAssistantSessions");
  const referralAiTotal = sumAi("referralAiSessions");
  const unassignedAiTotal = sumAi("unassignedAiSessions");
  const directTotal = sumAi("directSessions");
  const directAiEstimate = estimateDirectAiSessions(directTotal);
  const sparklineForAi = (
    field: "aiAssistantSessions" | "referralAiSessions" | "unassignedAiSessions" | "directSessions",
  ): SessionCountPoint[] => aiInRange.map((s) => ({ key: s.id, dateLabel: dateLabel(s.date), value: s[field] ?? 0 }));

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}</h1>
          {client.domain && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>}
        </div>
        <DateRangePicker allTimeRange={allTimeRange} />
      </header>

      {ga4InRange.length === 0 && gscInRange.length === 0 && aiInRange.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          No analytics data in this range yet — connect a Google account in{" "}
          <a href={`/clients/${id}/settings`} className="underline">
            Settings
          </a>{" "}
          and the daily pull will populate this.
        </div>
      ) : (
        <>
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Google Analytics
            </h2>
            {ga4InRange.length === 0 ? (
              <div className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                No GA4 data in this range.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Sessions
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                    {sessions.toLocaleString()}
                  </div>
                  <div className="mt-2">
                    <SessionCountSparkline points={sessionsTrend} />
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Active Users
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                    {activeUsers.toLocaleString()}
                  </div>
                  <div className="mt-2">
                    <SessionCountSparkline points={usersTrend} color="#2563eb" />
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Search Console
            </h2>
            {gscInRange.length === 0 ? (
              <div className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                No GSC data in this range.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Clicks
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                      {clicks.toLocaleString()}
                    </div>
                    <div className="mt-2">
                      <SessionCountSparkline points={clicksTrend} color="#059669" />
                    </div>
                  </div>
                  <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Impressions
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                      {impressions.toLocaleString()}
                    </div>
                    <div className="mt-2">
                      <SessionCountSparkline points={impressionsTrend} color="#d97706" />
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-sm">
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400">Avg CTR: </span>
                    <span className="tabular-nums text-zinc-900 dark:text-zinc-100">
                      {avgCtr != null ? `${(avgCtr * 100).toFixed(1)}%` : "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400">Avg Position: </span>
                    <span className="tabular-nums text-zinc-900 dark:text-zinc-100">
                      {avgPosition != null ? avgPosition.toFixed(1) : "—"}
                    </span>
                  </div>
                </div>
              </>
            )}
          </section>

          <section>
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              AI Platform Traffic
            </h2>
            <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
              Does not include Google AI Overviews/AI Mode (Organic) -- no reliable way to separate that from
              regular organic search currently exists.
            </p>
            {aiInRange.length === 0 ? (
              <div className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                No AI traffic data in this range.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    AI Assistant
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                    {aiAssistantTotal.toLocaleString()}
                  </div>
                  <div className="mt-2">
                    <SessionCountSparkline points={sparklineForAi("aiAssistantSessions")} />
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Referral (AI)
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                    {referralAiTotal.toLocaleString()}
                  </div>
                  <div className="mt-2">
                    <SessionCountSparkline points={sparklineForAi("referralAiSessions")} color="#7c3aed" />
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Unassigned (AI)
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                    {unassignedAiTotal.toLocaleString()}
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
                    ~{directAiEstimate.mid.toLocaleString()}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {directAiEstimate.low.toLocaleString()}–{directAiEstimate.high.toLocaleString()} range (21–47%
                    of {directTotal.toLocaleString()} Direct sessions)
                  </div>
                  <div className="mt-2">
                    <SessionCountSparkline points={sparklineForAi("directSessions")} color="#71717a" />
                  </div>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
