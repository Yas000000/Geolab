import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { PrintButton } from "@/components/print-button";
import { trafficIsPartial, type MonthlyReportData, type ReportTakeaways, type ScoreMetrics, type TrafficTotals } from "@/lib/monthly-report";

export const dynamic = "force-dynamic";

// Client-facing copy on this page follows the house style: no em dashes, no
// Oxford commas. Empty cells read "n/a", never a dash.

async function getReport(id: string) {
  return prisma.monthlyReport.findUnique({ where: { id }, select: { clientId: true, data: true, takeaways: true, updatedAt: true } });
}

export async function generateMetadata({ params }: { params: Promise<{ reportId: string }> }): Promise<Metadata> {
  const report = await getReport((await params).reportId);
  const d = report?.data as unknown as MonthlyReportData | undefined;
  return { title: d ? `${d.clientName}: GEO Report, ${d.monthLabel}` : "GEO Report" };
}

const RED = "#EC1912";

// Print layout: US Letter, one section per page, colors kept when printing.
const PRINT_CSS = `
@page { size: letter; margin: 0; }
.rpt { font-family: "Noway", "Segoe UI", Arial, sans-serif; color: #1a1a1a; }
.rpt-page { width: 8.5in; min-height: 11in; margin: 0 auto 24px; background: #fff; position: relative;
  padding: 0.75in 0.7in; box-shadow: 0 1px 4px rgba(0,0,0,.15); }
.rpt-page::after { content: ""; position: absolute; top: 0; right: 0; width: 1.35in; height: 0.45in;
  background: url("/brand/interdependence-logo.jpg") center / cover no-repeat; }
.rpt-cover { background: ${RED}; color: #fff; display: flex; flex-direction: column; justify-content: center; }
.rpt-cover::after { display: none; }
@media print {
  html, body { background: #fff !important; }
  .rpt { padding: 0 !important; background: #fff !important; }
  .rpt-toolbar { display: none !important; }
  /* Sections flow and start on a fresh sheet; only the cover is pinned to one
     sheet (just under 11in -- exactly 11in can spill a blank page in Chrome). */
  .rpt-page { margin: 0; box-shadow: none; min-height: 0; break-after: page; page-break-after: always; }
  .rpt-cover { height: 10.95in; overflow: hidden; }
  .rpt-page:last-child { break-after: auto; page-break-after: auto; }
  .rpt * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .rpt tr { break-inside: avoid; }
}
`;

const fmtPct = (n: number | null | undefined) => (n == null ? "n/a" : `${n.toFixed(1)}%`);
const fmtRank = (n: number | null | undefined) => (n == null ? "n/a" : n.toFixed(1));
const fmtInt = (n: number | null | undefined) => (n == null ? "n/a" : Math.round(n).toLocaleString("en-US"));
const fmtBest = (n: number | null | undefined) => (n == null ? "Not found" : `#${n}`);

/** A change pill. lowerIsBetter flips the color for ranks. */
function Delta({ cur, prev, unit, lowerIsBetter = false, digits = 1 }: { cur: number | null | undefined; prev: number | null | undefined; unit: string; lowerIsBetter?: boolean; digits?: number }) {
  if (cur == null || prev == null) return <span className="text-zinc-400">n/a</span>;
  const diff = cur - prev;
  const rounded = Number(diff.toFixed(digits));
  if (rounded === 0) return <span className="text-zinc-500">No change</span>;
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  return (
    <span className={good ? "text-green-700" : "text-red-700"}>
      {diff > 0 ? "▲" : "▼"} {Math.abs(rounded).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}
      {unit}
    </span>
  );
}

function SectionHeader({ n, title, sub }: { n: number; title: string; sub: string }) {
  return (
    <div className="mb-6">
      <div className="text-[10px] font-bold tracking-[0.22em] uppercase" style={{ color: RED }}>
        Section {String(n).padStart(2, "0")}
      </div>
      <h2 className="mt-1 text-[26px] font-bold tracking-tight text-[#1E1E1E]">{title}</h2>
      <p className="mt-1 text-[12px] text-zinc-500">{sub}</p>
      <div className="mt-4 h-[2px]" style={{ background: `linear-gradient(90deg, ${RED} 0%, transparent 60%)` }} />
    </div>
  );
}

function Takeaway({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <div className="mt-5 rounded-lg border-l-4 bg-[#FAF5F5] px-4 py-3 text-[12.5px] leading-relaxed" style={{ borderColor: RED }}>
      <span className="font-bold">Key Takeaway: </span>
      {text}
    </div>
  );
}

function StatCard({ label, value, prev, delta }: { label: string; value: string; prev: string | null; delta: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#E8D8D8] px-4 py-3">
      <div className="text-[10px] font-bold tracking-wider text-zinc-500 uppercase">{label}</div>
      <div className="mt-1 text-[26px] font-bold text-[#1E1E1E] tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] text-zinc-500">
        {prev != null ? (
          <>
            {prev} last month · {delta}
          </>
        ) : (
          "No data last month"
        )}
      </div>
    </div>
  );
}

const th = "px-3 py-2 text-left text-[10px] font-bold tracking-wider text-zinc-500 uppercase";
const thR = `${th} text-right`;
const td = "px-3 py-1.5 text-[12px]";
const tdR = `${td} text-right tabular-nums`;

function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[#E8D8D8]">
      <table className="w-full border-collapse">{children}</table>
    </div>
  );
}

function scoreCards(cur: ScoreMetrics, prev: ScoreMetrics | null) {
  return [
    { label: "Visibility", value: fmtPct(cur.visibilityPct), prev: prev && fmtPct(prev.visibilityPct), delta: <Delta cur={cur.visibilityPct} prev={prev?.visibilityPct} unit=" pts" /> },
    { label: "Avg Rank When Found", value: fmtRank(cur.avgRankWhenFound), prev: prev && fmtRank(prev.avgRankWhenFound), delta: <Delta cur={cur.avgRankWhenFound} prev={prev?.avgRankWhenFound} unit="" lowerIsBetter /> },
    { label: "#1 Rankings", value: fmtInt(cur.rank1Count), prev: prev && fmtInt(prev.rank1Count), delta: <Delta cur={cur.rank1Count} prev={prev?.rank1Count} unit="" digits={0} /> },
    { label: "Top-3 Visibility", value: fmtPct(cur.top3Pct), prev: prev && fmtPct(prev.top3Pct), delta: <Delta cur={cur.top3Pct} prev={prev?.top3Pct} unit=" pts" /> },
    { label: "Sentiment Score", value: fmtPct(cur.sentimentPct), prev: prev && fmtPct(prev.sentimentPct), delta: <Delta cur={cur.sentimentPct} prev={prev?.sentimentPct} unit=" pts" /> },
  ];
}

function TrafficRow({ label, cur, prev, showChange }: { label: string; cur: number | null; prev: number | null | undefined; showChange: boolean }) {
  return (
    <tr className="border-t border-[#F0E6E6]">
      <td className={td}>{label}</td>
      <td className={tdR}>{prev === undefined ? "n/a" : fmtInt(prev)}</td>
      <td className={`${tdR} font-semibold`}>{fmtInt(cur)}</td>
      {showChange && (
        <td className={tdR}>
          <Delta cur={cur} prev={prev ?? null} unit="" digits={0} />
        </td>
      )}
    </tr>
  );
}

const coverage = (t: TrafficTotals, label: string) => `${t.days} of ${t.daysInMonth} days in ${label}`;

export default async function MonthlyReportPage({ params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  const report = await getReport(reportId);
  if (!report) notFound();
  const d = report.data as unknown as MonthlyReportData;
  const t = report.takeaways as unknown as ReportTakeaways;
  const brand = d.brandName ?? d.clientName;
  const cur = d.scorecard.current;
  const prev = d.scorecard.previous;
  const prevTraffic: TrafficTotals | null | undefined = d.traffic?.previous;
  const trafficPartial = d.traffic ? trafficIsPartial(d.traffic) : false;
  // No data last month: drop the "then" and change columns instead of filling them with n/a.
  const hasPrev = !!prev;
  let n = 0;

  return (
    <div className="rpt min-h-screen bg-zinc-200 py-6">
      <style>{PRINT_CSS}</style>
      <div className="rpt-toolbar mx-auto mb-4 flex w-[8.5in] items-center justify-between">
        <a href={`/clients/${report.clientId}/reports`} className="text-sm text-zinc-600 hover:underline">
          ← Reports
        </a>
        <PrintButton />
      </div>

      {/* Cover */}
      <section className="rpt-page rpt-cover">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/interdependence-logo.jpg" alt="Interdependence" className="absolute top-[0.6in] left-[0.5in] w-[3in]" />
        <div className="mb-8 text-[11px] font-semibold tracking-[0.18em] text-white/80 uppercase">GEO Report</div>
        <h1 className="text-[44px] leading-tight font-bold tracking-tight">{d.clientName}</h1>
        <p className="mt-2 text-[17px] text-white/85">AI Visibility Report for {d.monthLabel}</p>
        <div className="my-10 h-[3px] w-[60px] bg-white" />
        <div className="space-y-2 text-[13px] text-white/85">
          {d.domain && (
            <div>
              <strong className="text-white">Website:</strong> {d.domain}
            </div>
          )}
          <div>
            <strong className="text-white">Period:</strong> {d.monthLabel} compared with {d.previousMonthLabel}
          </div>
          <div>
            <strong className="text-white">AI platforms:</strong> {d.platforms.map((p) => p.label).join(", ") || "n/a"}
          </div>
        </div>
        <div className="absolute right-[0.7in] bottom-[0.6in] left-[0.7in] flex justify-between border-t border-white/35 pt-4 text-[11px] text-white/75">
          <span>Prepared by Interdependence</span>
          <span>{d.monthLabel}</span>
        </div>
      </section>

      {/* Executive Scorecard */}
      <section className="rpt-page">
        <SectionHeader n={++n} title="Executive Scorecard" sub={`How often AI answers mention ${brand}, ${d.monthLabel} compared with ${d.previousMonthLabel}.`} />
        {cur.checks === 0 ? (
          <p className="text-[13px] text-zinc-600">No AI answers were checked in {d.monthLabel}.</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {scoreCards(cur, prev).map((c) => (
                <StatCard key={c.label} {...c} />
              ))}
              {d.citations && (
                <StatCard
                  label="Answers Citing Your Site"
                  value={fmtPct(d.citations.current.ownSitePct)}
                  prev={d.citations.previous ? fmtPct(d.citations.previous.ownSitePct) : null}
                  delta={<Delta cur={d.citations.current.ownSitePct} prev={d.citations.previous?.ownSitePct} unit=" pts" />}
                />
              )}
            </div>
            <Takeaway text={t.scorecard} />
            <p className="mt-6 text-[11px] leading-relaxed text-zinc-500">
              Based on {fmtInt(cur.checks)} AI answers from {d.runs.current.runs} tracking run
              {d.runs.current.runs === 1 ? "" : "s"} in {d.monthLabel} ({d.runs.current.live} with live web search and{" "}
              {d.runs.current.training} from the AI&apos;s training data)
              {prev ? `, compared with ${fmtInt(prev.checks)} answers in ${d.previousMonthLabel}` : ""}.
              Visibility is the share of answers that mention {brand}. Top-3 Visibility is the share of all answers
              where {brand} is listed in the top 3. Sentiment Score is the share of mentions that are not negative.
            </p>
          </>
        )}
      </section>

      {/* Platforms */}
      {d.platforms.length > 0 && (
        <section className="rpt-page">
          <SectionHeader n={++n} title="Visibility by AI Platform" sub="How each AI platform's answers treated the brand this month and last." />
          <Table>
            <thead className="bg-[#FAF5F5]">
              <tr>
                <th className={th}>Platform</th>
                {hasPrev && <th className={thR}>{d.previousMonthLabel}</th>}
                <th className={thR}>{hasPrev ? d.monthLabel : "Visibility"}</th>
                {hasPrev && <th className={thR}>Change</th>}
                {hasPrev && <th className={thR}>Avg Rank Then</th>}
                <th className={thR}>{hasPrev ? "Avg Rank Now" : "Avg Rank When Found"}</th>
              </tr>
            </thead>
            <tbody>
              {d.platforms.map((p) => (
                <tr key={p.platform} className="border-t border-[#F0E6E6]">
                  <td className={`${td} font-semibold`}>{p.label}</td>
                  {hasPrev && <td className={tdR}>{fmtPct(p.previous?.visibilityPct)}</td>}
                  <td className={`${tdR} font-semibold`}>{fmtPct(p.current?.visibilityPct)}</td>
                  {hasPrev && (
                    <td className={tdR}>
                      <Delta cur={p.current?.visibilityPct} prev={p.previous?.visibilityPct} unit=" pts" />
                    </td>
                  )}
                  {hasPrev && <td className={tdR}>{fmtRank(p.previous?.avgRank)}</td>}
                  <td className={tdR}>{fmtRank(p.current?.avgRank)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Takeaway text={t.platforms} />
        </section>
      )}

      {/* Prompt Movement */}
      {cur.checks > 0 && (
        <section className="rpt-page">
          <SectionHeader n={++n} title="Prompt Movement" sub={`Where ${brand} gained ground across the ${d.prompts.tracked} tracked prompts, and where a competitor still leads.`} />
          {[
            { title: "New Wins", note: "Not mentioned last month, mentioned now.", rows: d.prompts.newWins, watch: false },
            { title: "Rank Gains", note: "Mentioned both months, with a better best rank now.", rows: d.prompts.rankGains, watch: false },
            { title: "Watchlist", note: "Mentioned, but another brand holds the #1 spot.", rows: d.prompts.watchlist, watch: true },
          ].map((b) => (
            <div key={b.title} className="mb-5">
              <h3 className="text-[13px] font-bold text-[#1E1E1E]">
                {b.title} {(hasPrev || b.watch) && <span className="font-normal text-zinc-500">({b.rows.length})</span>}
              </h3>
              <p className="mb-2 text-[11px] text-zinc-500">{b.note}</p>
              {!hasPrev && !b.watch ? (
                <p className="text-[12px] text-zinc-500">No {d.previousMonthLabel} data to compare with yet.</p>
              ) : b.rows.length === 0 ? (
                <p className="text-[12px] text-zinc-500">None this month.</p>
              ) : (
                <Table>
                  <thead className="bg-[#FAF5F5]">
                    <tr>
                      <th className={th}>Prompt</th>
                      {hasPrev && <th className={thR}>Best Rank Then</th>}
                      <th className={thR}>{hasPrev ? "Best Rank Now" : "Best Rank"}</th>
                      {b.watch && <th className={th}>Most Often #1</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.slice(0, 12).map((m) => (
                      <tr key={m.text} className="border-t border-[#F0E6E6]">
                        <td className={td}>{m.text}</td>
                        {hasPrev && <td className={tdR}>{m.previouslyTracked ? fmtBest(m.previousBestRank) : "n/a"}</td>}
                        <td className={`${tdR} font-semibold`}>{fmtBest(m.currentBestRank)}</td>
                        {b.watch && <td className={td}>{m.outrankedBy ?? "n/a"}</td>}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {b.rows.length > 12 && <p className="mt-1 text-[11px] text-zinc-500">Showing 12 of {b.rows.length}.</p>}
            </div>
          ))}
          <Takeaway text={t.prompts} />
        </section>
      )}

      {/* Competitors */}
      {d.competitors.length > 0 && (
        <section className="rpt-page">
          <SectionHeader n={++n} title="Competitor Share of Voice" sub="Each brand's share of all brand mentions in AI answers, for the most mentioned brands this month." />
          <Table>
            <thead className="bg-[#FAF5F5]">
              <tr>
                <th className={th}>Brand</th>
                {hasPrev && <th className={thR}>{d.previousMonthLabel}</th>}
                <th className={thR}>{hasPrev ? d.monthLabel : "Share of Voice"}</th>
                {hasPrev && <th className={thR}>Change</th>}
                <th className={thR}>Visibility</th>
              </tr>
            </thead>
            <tbody>
              {d.competitors.map((c) => (
                <tr key={c.name} className={`border-t border-[#F0E6E6] ${c.isClient ? "bg-[#FDECEC] font-semibold" : ""}`}>
                  <td className={td}>{c.name}</td>
                  {hasPrev && <td className={tdR}>{c.previousSovPct == null ? "Not mentioned" : fmtPct(c.previousSovPct)}</td>}
                  <td className={tdR}>{fmtPct(c.currentSovPct)}</td>
                  {hasPrev && (
                    <td className={tdR}>
                      <Delta cur={c.currentSovPct} prev={c.previousSovPct} unit=" pts" />
                    </td>
                  )}
                  <td className={tdR}>{fmtPct(c.currentVisibilityPct)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] text-zinc-500">
            Visibility is the share of this month&apos;s AI answers that mention the brand.
          </p>
          <Takeaway text={t.competitors} />
        </section>
      )}

      {/* Citations */}
      {d.citations && (
        <section className="rpt-page">
          <SectionHeader n={++n} title="AI Citations" sub="The web pages AI answers linked to as sources. Only answers from live web search carry citations." />
          <div className="mb-5 grid grid-cols-3 gap-3">
            <StatCard
              label="Answers Citing Your Site"
              value={fmtPct(d.citations.current.ownSitePct)}
              prev={d.citations.previous ? fmtPct(d.citations.previous.ownSitePct) : null}
              delta={<Delta cur={d.citations.current.ownSitePct} prev={d.citations.previous?.ownSitePct} unit=" pts" />}
            />
            <StatCard label="Live Search Answers" value={fmtInt(d.citations.current.answers)} prev={d.citations.previous ? fmtInt(d.citations.previous.answers) : null} delta={<Delta cur={d.citations.current.answers} prev={d.citations.previous?.answers} unit="" digits={0} />} />
            <StatCard label="Sites Cited" value={fmtInt(d.citations.current.sitesCited)} prev={null} delta={null} />
          </div>
          {/* Takeaway up top here: this section runs long, and at the bottom it could land alone on the next sheet. */}
          <div className="mb-5">
            <Takeaway text={t.citations} />
          </div>
          <h3 className="mb-2 text-[13px] font-bold text-[#1E1E1E]">Most Cited Sites</h3>
          <Table>
            <thead className="bg-[#FAF5F5]">
              <tr>
                <th className={th}>Site</th>
                {d.citations.previous && <th className={thR}>Share Then</th>}
                <th className={thR}>{d.citations.previous ? "Share Now" : "Share"}</th>
                {d.citations.previous && <th className={thR}>Change</th>}
              </tr>
            </thead>
            <tbody>
              {d.citations.topSites.map((s) => (
                <tr key={s.domain} className={`border-t border-[#F0E6E6] ${s.isOwn ? "bg-[#FDECEC] font-semibold" : ""}`}>
                  <td className={td}>{s.domain}</td>
                  {d.citations!.previous && <td className={tdR}>{fmtPct(s.previousSharePct)}</td>}
                  <td className={tdR}>{fmtPct(s.sharePct)}</td>
                  {d.citations!.previous && (
                    <td className={tdR}>
                      <Delta cur={s.sharePct} prev={s.previousSharePct} unit=" pts" />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-1 text-[11px] text-zinc-500">Share is the percentage of live search answers that cite the site at least once.</p>
          {d.citations.ownPages.length > 0 && (
            <>
              <h3 className="mt-5 mb-2 text-[13px] font-bold text-[#1E1E1E]">Your Most Cited Pages</h3>
              <Table>
                <thead className="bg-[#FAF5F5]">
                  <tr>
                    <th className={th}>Page</th>
                    <th className={thR}>Answers</th>
                  </tr>
                </thead>
                <tbody>
                  {d.citations.ownPages.map((p) => (
                    <tr key={p.url} className="border-t border-[#F0E6E6]">
                      <td className={td}>
                        <a href={p.url} className="underline" style={{ color: RED }}>
                          {p.title ?? p.url}
                        </a>
                      </td>
                      <td className={tdR}>{p.answers}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </section>
      )}

      {/* Traffic + crawler access */}
      {(d.traffic || d.crawl) && (
        <section className="rpt-page">
          {d.traffic && (
            <>
              <SectionHeader n={++n} title="AI Platform Traffic" sub="Visits to the website that Google Analytics attributes to AI platforms." />
              <Table>
                <thead className="bg-[#FAF5F5]">
                  <tr>
                    <th className={th}>Source</th>
                    <th className={thR}>{d.previousMonthLabel}</th>
                    <th className={thR}>{d.monthLabel}</th>
                    {!trafficPartial && <th className={thR}>Change</th>}
                  </tr>
                </thead>
                <tbody>
                  <TrafficRow label="AI Assistant channel" cur={d.traffic.current.aiAssistant} prev={prevTraffic?.aiAssistant} showChange={!trafficPartial} />
                  <TrafficRow label="Referrals from AI platforms" cur={d.traffic.current.referralAi} prev={prevTraffic?.referralAi} showChange={!trafficPartial} />
                  <TrafficRow label="Unassigned visits from AI platforms" cur={d.traffic.current.unassignedAi} prev={prevTraffic?.unassignedAi} showChange={!trafficPartial} />
                  <TrafficRow label="Measured AI visits, total" cur={d.traffic.current.measuredAiTotal} prev={prevTraffic?.measuredAiTotal} showChange={!trafficPartial} />
                  <TrafficRow label="All website sessions" cur={d.traffic.current.sessions} prev={prevTraffic?.sessions} showChange={!trafficPartial} />
                  {d.traffic.current.gscClicks != null && (
                    <TrafficRow label="Google Search clicks" cur={d.traffic.current.gscClicks} prev={prevTraffic?.gscClicks} showChange={!trafficPartial} />
                  )}
                </tbody>
              </Table>
              {trafficPartial && (
                <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                  Google Analytics data covers {coverage(d.traffic.current, d.monthLabel)}
                  {prevTraffic ? ` and ${coverage(prevTraffic, d.previousMonthLabel)}` : ""}, so the monthly totals
                  can&apos;t be compared directly.
                </p>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                Direct visits arrive with no referrer, so AI visits among them can&apos;t be measured. Industry research
                puts 21% to 47% of Direct visits as AI-referred, which would mean about{" "}
                {fmtInt(d.traffic.current.directAiEstimate.low)} to {fmtInt(d.traffic.current.directAiEstimate.high)} of
                this month&apos;s {fmtInt(d.traffic.current.direct)} Direct visits. That range is an estimate, not a
                measurement. Visits from Google&apos;s AI Overviews are counted as ordinary Google Search traffic and
                can&apos;t be separated.
              </p>
              <Takeaway text={t.traffic} />
            </>
          )}
          {d.crawl && (
            <div className={d.traffic ? "mt-10" : ""}>
              {d.traffic ? (
                <h3 className="mb-1 text-[16px] font-bold text-[#1E1E1E]">AI Crawler Access</h3>
              ) : (
                <SectionHeader n={++n} title="AI Crawler Access" sub="Whether each AI platform can reach the website." />
              )}
              <p className="mb-2 text-[11px] text-zinc-500">
                Checked{" "}
                {new Date(d.crawl.checkedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}{" "}
                against {d.crawl.url}. A site AI platforms can&apos;t reach can&apos;t be cited.
              </p>
              <Table>
                <tbody>
                  {d.crawl.results.map((r) => (
                    <tr key={r.label} className="border-t border-[#F0E6E6] first:border-t-0">
                      <td className={`${td} font-semibold`}>{r.label}</td>
                      <td className={`${td} ${r.success ? "text-green-700" : "text-red-700"}`}>
                        {r.success ? "Reached the site" : "Could not confirm access"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
