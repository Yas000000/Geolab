import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { PrintButton } from "@/components/print-button";
import {
  normalizeReportData,
  trafficCaveat,
  type CompareScore,
  type CompetitorFigures,
  type ReportTakeaways,
  type ScoreMetrics,
  type TrafficTotals,
} from "@/lib/monthly-report";

export const dynamic = "force-dynamic";

// Client-facing copy on this page follows the house style: no em dashes, no
// Oxford commas. Empty cells read "n/a", never a dash.

async function getReport(id: string) {
  return prisma.monthlyReport.findUnique({ where: { id }, select: { clientId: true, data: true, takeaways: true, updatedAt: true } });
}

export async function generateMetadata({ params }: { params: Promise<{ reportId: string }> }): Promise<Metadata> {
  const report = await getReport((await params).reportId);
  const d = report ? normalizeReportData(report.data) : undefined;
  return { title: d ? `${d.clientName}: GEO Report, ${d.period.label}` : "GEO Report" };
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

// Changes are written the way the Monthly GEO Report tool writes them: points
// and relative change together ("+9.6 pts / +9600.0%"), counts the same way
// ("+20 / +117.6%"), ranks and positions as a plain difference ("-0.3", lower
// is better). Worked out from the figures as shown (one decimal), and a 0
// starting point counts as 0.1 for the relative change, as in that tool.
type ChangeKind = "pts" | "count" | "rank";
interface ChangeValue {
  text: string;
  tone: "good" | "bad" | "flat";
}

const NBSP = "\u00a0";
const signed = (x: number, digits: number) =>
  `${x > 0 ? "+" : ""}${x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

function change(cur: number | null | undefined, prev: number | null | undefined, kind: ChangeKind): ChangeValue | null {
  if (cur == null || prev == null) return null;
  const digits = kind === "count" ? 0 : 1;
  const round = (x: number) => Number(x.toFixed(digits));
  const c = round(cur);
  const p = round(prev);
  const diff = round(c - p);
  const tone = diff === 0 ? "flat" : (kind === "rank" ? diff < 0 : diff > 0) ? "good" : "bad";
  if (kind === "rank") return { text: signed(diff, 1), tone };
  const base = p === 0 ? (c === 0 ? null : 0.1) : p;
  const rel = base == null ? 0 : ((c - base) / base) * 100;
  return { text: `${signed(diff, digits)}${kind === "pts" ? `${NBSP}pts` : ""} / ${signed(rel, 1)}%`, tone };
}

const TONE_TEXT = { good: "text-green-700", bad: "text-red-700", flat: "text-zinc-500" } as const;
const TONE_PILL = { good: "bg-green-100 text-green-800", bad: "bg-red-100 text-red-800", flat: "bg-zinc-100 text-zinc-600" } as const;

/** A change in a table cell: green when better, red when worse, "n/a" when there's nothing to compare. */
function Change({ cur, prev, kind }: { cur: number | null | undefined; prev: number | null | undefined; kind: ChangeKind }) {
  const v = change(cur, prev, kind);
  if (!v) return <span className="text-zinc-400">n/a</span>;
  return <span className={`font-semibold ${TONE_TEXT[v.tone]}`}>{v.text}</span>;
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

/** then: "in September 2026" / "at the ISA benchmark"; missing: the footer when there's no comparison figure. */
function StatCard({
  label,
  value,
  prev,
  diff,
  then,
  missing,
}: {
  label: string;
  value: string;
  prev: string | null;
  diff: ChangeValue | null;
  then: string;
  missing: string;
}) {
  return (
    <div className="rounded-lg border border-[#E8D8D8] px-4 py-3">
      <div className="text-[10px] font-bold tracking-wider text-zinc-500 uppercase">{label}</div>
      <div className="mt-1 text-[26px] font-bold text-[#1E1E1E] tabular-nums">{value}</div>
      {prev != null ? (
        <>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            was {prev} {then}
          </div>
          {diff && (
            <div className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${TONE_PILL[diff.tone]}`}>
              {diff.text}
            </div>
          )}
        </>
      ) : (
        <div className="mt-0.5 text-[11px] text-zinc-500">{missing}</div>
      )}
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

/**
 * The scorecard tiles. A figure an imported benchmark doesn't have comes back
 * as prev: null (the tile shows why); a figure a tracked period has but that
 * was empty (e.g. no rank when never mentioned) shows "n/a".
 */
function scoreCards(cur: ScoreMetrics, prev: CompareScore | null, fromBenchmark: boolean) {
  const then = <T,>(v: T | null | undefined, fmt: (x: T | null) => string) =>
    !prev || (fromBenchmark && v == null) ? null : fmt(v ?? null);
  return [
    { label: "Visibility", value: fmtPct(cur.visibilityPct), prev: then(prev?.visibilityPct, fmtPct), diff: change(cur.visibilityPct, prev?.visibilityPct, "pts") },
    { label: "Avg Rank When Found", value: fmtRank(cur.avgRankWhenFound), prev: then(prev?.avgRankWhenFound, fmtRank), diff: change(cur.avgRankWhenFound, prev?.avgRankWhenFound, "rank") },
    { label: "#1 Rankings", value: fmtInt(cur.rank1Count), prev: then(prev?.rank1Count, fmtInt), diff: change(cur.rank1Count, prev?.rank1Count, "count") },
    { label: "Top-3 Visibility", value: fmtPct(cur.top3Pct), prev: then(prev?.top3Pct, fmtPct), diff: change(cur.top3Pct, prev?.top3Pct, "pts") },
    { label: "Sentiment Score", value: fmtPct(cur.sentimentPct), prev: then(prev?.sentimentPct, fmtPct), diff: change(cur.sentimentPct, prev?.sentimentPct, "pts") },
  ];
}

function TrafficRow({ label, cur, prev }: { label: string; cur: number | null; prev: number | null | undefined }) {
  return (
    <tr className="border-t border-[#F0E6E6]">
      <td className={td}>{label}</td>
      <td className={tdR}>{prev === undefined ? "n/a" : fmtInt(prev)}</td>
      <td className={`${tdR} font-semibold`}>{fmtInt(cur)}</td>
      <td className={tdR}>
        <Change cur={cur} prev={prev} kind="count" />
      </td>
    </tr>
  );
}

/** A competitor's figure for one metric, or "n/a". */
function fig(f: CompetitorFigures | null, k: keyof CompetitorFigures) {
  const v = f?.[k];
  return v == null ? "n/a" : k === "position" ? v.toFixed(1) : `${v.toFixed(1)}%`;
}

export default async function MonthlyReportPage({ params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  const report = await getReport(reportId);
  if (!report) notFound();
  const d = normalizeReportData(report.data);
  const t = report.takeaways as unknown as ReportTakeaways;
  const brand = d.brandName ?? d.clientName;
  const c = d.compare;
  const P = d.period.label;
  const isBenchmark = c.kind === "benchmark";
  const cur = d.scorecard.current;
  const prev = d.scorecard.previous;
  const prevTraffic: TrafficTotals | null | undefined = d.traffic?.previous;
  const trafficLabel = c.trafficPeriod?.label ?? c.label;
  const trafficNote = d.traffic ? trafficCaveat(d.traffic, P, trafficLabel) : null;
  // How the comparison reads inside a sentence: "in September 2026", "at the ISA benchmark".
  const then = isBenchmark ? `at the ${c.source} benchmark` : c.kind === "firstCrawl" ? "at the first crawl" : `in ${c.label}`;
  const missing = isBenchmark ? "Not part of the benchmark" : `No data ${then}`;
  // Nothing to compare with: drop the "then" and change columns instead of filling them with n/a.
  // Against an imported benchmark, each platform is compared with its own figures when it has
  // them (uncovered: platforms it didn't include), else with its one all-platform figure.
  const platformsCompared = d.platforms.some((p) => p.previous);
  const uncovered = c.byPlatform ? d.platforms.filter((p) => !p.previous).map((p) => p.label) : [];
  const competitorsCompared = d.competitors.some((x) => x.previous);
  // Answers citing the site in the comparison: an imported benchmark's own figure when it has
  // one (MacuMira's, from its keyword.com export), else it counts as 0 there.
  const citingThen =
    d.citations?.previous?.ownSitePct ?? c.ownSiteCitedPct ?? (c.assumedZero?.includes("Answers Citing Your Site") ? 0 : null);
  // "A, B and C": house style, no Oxford comma.
  const andList = (xs: string[]) => xs.reduce((acc, x, i) => (i === 0 ? x : `${acc}${i === xs.length - 1 ? " and " : ", "}${x}`), "");
  // How the benchmark's scorecard figures were filled in, for the note under the tiles.
  const fromTable = {
    rank1: !!c.fromPromptTable?.includes("#1 Rankings"),
    top3: !!c.fromPromptTable?.includes("Top-3 Visibility"),
  };
  const benchmarkNote = isBenchmark
    ? [
        // Only the figures worked out from its prompt table; ones the benchmark states need no note.
        c.fromPromptTable?.length &&
          `${[
            fromTable.rank1 && `#1 Rankings ${then} counts its prompts where ${brand} ranked #1`,
            fromTable.top3 && `Top-3 Visibility${fromTable.rank1 ? "" : ` ${then}`} is its visibility from prompts ranked in the top 3`,
          ]
            .filter(Boolean)
            .join(", and ")}, from its prompt table.`,
        c.sentimentScore != null && `Its sentiment score of ${c.sentimentScore}/100 counts as ${c.sentimentScore}%.`,
        c.assumedZero?.length &&
          `It didn't report ${andList(c.assumedZero)}, so ${c.assumedZero.length === 1 ? "that counts" : "those count"} as 0 there.`,
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const cards = scoreCards(cur, prev, isBenchmark).map((card) => ({ ...card, missing }));
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
        <p className="mt-2 text-[17px] text-white/85">AI Visibility Report for {P}</p>
        <div className="my-10 h-[3px] w-[60px] bg-white" />
        <div className="space-y-2 text-[13px] text-white/85">
          {d.domain && (
            <div>
              <strong className="text-white">Website:</strong> {d.domain}
            </div>
          )}
          <div>
            <strong className="text-white">Period:</strong> {P} compared with {c.phrase}
          </div>
          <div>
            <strong className="text-white">AI platforms:</strong> {d.platforms.map((p) => p.label).join(", ") || "n/a"}
          </div>
        </div>
        <div className="absolute right-[0.7in] bottom-[0.6in] left-[0.7in] flex justify-between border-t border-white/35 pt-4 text-[11px] text-white/75">
          <span>Prepared by Interdependence</span>
          <span>{P}</span>
        </div>
      </section>

      {/* Executive Scorecard */}
      <section className="rpt-page">
        <SectionHeader n={++n} title="Executive Scorecard" sub={`How often AI answers mention ${brand}, ${P} compared with ${c.phrase}.`} />
        {cur.checks === 0 ? (
          <p className="text-[13px] text-zinc-600">No AI answers were checked in {P}.</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {cards.map((card) => (
                <StatCard key={card.label} then={then} {...card} />
              ))}
              {d.citations && (
                <StatCard
                  label="Answers Citing Your Site"
                  value={fmtPct(d.citations.current.ownSitePct)}
                  prev={citingThen != null ? fmtPct(citingThen) : null}
                  diff={change(d.citations.current.ownSitePct, citingThen, "pts")}
                  then={then}
                  missing={missing}
                />
              )}
            </div>
            <Takeaway text={t.scorecard} />
            <p className="mt-6 text-[11px] leading-relaxed text-zinc-500">
              Based on {fmtInt(cur.checks)} AI answers from {d.runs.current.runs} tracking run
              {d.runs.current.runs === 1 ? "" : "s"} in {P} ({d.runs.current.live} with live web search and{" "}
              {d.runs.current.training} from the AI&apos;s training data)
              {prev?.checks != null ? `, compared with ${fmtInt(prev.checks)} answers ${then}` : ""}.
              {isBenchmark && prev && ` The comparison figures are from ${c.phrase}.`}
              {benchmarkNote && ` ${benchmarkNote}`}{" "}
              Visibility is the share of answers that mention {brand}. Top-3 Visibility is the share of all answers
              where {brand} is listed in the top 3. Sentiment Score is the share of mentions that are not negative.
            </p>
          </>
        )}
      </section>

      {/* Platforms */}
      {d.platforms.length > 0 && (
        <section className="rpt-page">
          <SectionHeader
            n={++n}
            title="Visibility by AI Platform"
            sub={platformsCompared ? `How each AI platform's answers treated the brand in ${P}, compared with ${c.phrase}.` : `How each AI platform's answers treated the brand in ${P}.`}
          />
          <Table>
            <thead className="bg-[#FAF5F5]">
              <tr>
                <th className={th}>Platform</th>
                {platformsCompared && <th className={thR}>{isBenchmark && !c.byPlatform ? `${c.label} (All Platforms)` : c.label}</th>}
                <th className={thR}>{platformsCompared ? P : "Visibility"}</th>
                {platformsCompared && <th className={thR}>Change</th>}
                {platformsCompared && <th className={thR}>Avg Rank Then</th>}
                <th className={thR}>{platformsCompared ? "Avg Rank Now" : "Avg Rank When Found"}</th>
                {platformsCompared && <th className={thR}>Avg Rank Change</th>}
              </tr>
            </thead>
            <tbody>
              {d.platforms.map((p) => (
                <tr key={p.platform} className="border-t border-[#F0E6E6]">
                  <td className={`${td} font-semibold`}>{p.label}</td>
                  {platformsCompared && <td className={tdR}>{fmtPct(p.previous?.visibilityPct)}</td>}
                  <td className={`${tdR} font-semibold`}>{fmtPct(p.current?.visibilityPct)}</td>
                  {platformsCompared && (
                    <td className={tdR}>
                      <Change cur={p.current?.visibilityPct} prev={p.previous?.visibilityPct} kind="pts" />
                    </td>
                  )}
                  {platformsCompared && <td className={tdR}>{fmtRank(p.previous?.avgRank)}</td>}
                  <td className={tdR}>{fmtRank(p.current?.avgRank)}</td>
                  {platformsCompared && (
                    <td className={tdR}>
                      <Change cur={p.current?.avgRank} prev={p.previous?.avgRank} kind="rank" />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
          {isBenchmark && platformsCompared && (
            <p className="mt-2 text-[11px] text-zinc-500">
              {c.byPlatform
                ? `Each platform is compared with its own figures at the ${c.source} benchmark.${uncovered.length ? ` ${andList(uncovered)} ${uncovered.length === 1 ? "wasn't" : "weren't"} part of it, so ${uncovered.length === 1 ? "it has" : "they have"} no change.` : ""}`
                : `The ${c.source} benchmark was measured across all platforms combined, so each platform's change is measured from that combined figure.`}
            </p>
          )}
          <Takeaway text={t.platforms} />
        </section>
      )}

      {/* Prompt Movement */}
      {cur.checks > 0 && (
        <section className="rpt-page">
          <SectionHeader n={++n} title="Prompt Movement" sub={`Where ${brand} gained ground across the ${d.prompts.tracked} tracked prompts, and where a competitor still leads.`} />
          {[
            { title: "New Wins", note: `Not mentioned ${then}, mentioned now.`, rows: d.prompts.newWins, watch: false },
            {
              title: "Rank Gains",
              note: `A better best rank now than ${then}, including prompts that went from not found to ranked.`,
              rows: d.prompts.rankGains,
              watch: false,
            },
            { title: "Watchlist", note: "Mentioned, but another brand holds the #1 spot.", rows: d.prompts.watchlist, watch: true },
          ].map((b) => (
            <div key={b.title} className="mb-5">
              <h3 className="text-[13px] font-bold text-[#1E1E1E]">
                {b.title} {(d.prompts.compared || b.watch) && <span className="font-normal text-zinc-500">({b.rows.length})</span>}
              </h3>
              <p className="mb-2 text-[11px] text-zinc-500">{b.note}</p>
              {!d.prompts.compared && !b.watch ? (
                <p className="text-[12px] text-zinc-500">No prompt results {then} to compare with.</p>
              ) : b.rows.length === 0 ? (
                <p className="text-[12px] text-zinc-500">None in {P}.</p>
              ) : (
                <Table>
                  <thead className="bg-[#FAF5F5]">
                    <tr>
                      <th className={th}>Prompt</th>
                      {d.prompts.compared && <th className={thR}>Best Rank Then</th>}
                      <th className={thR}>{d.prompts.compared ? "Best Rank Now" : "Best Rank"}</th>
                      {b.watch && <th className={th}>Most Often #1</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.slice(0, 12).map((m) => (
                      <tr key={m.text} className="border-t border-[#F0E6E6]">
                        <td className={td}>{m.text}</td>
                        {d.prompts.compared && <td className={tdR}>{m.previouslyTracked ? fmtBest(m.previousBestRank) : "n/a"}</td>}
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

      {/* Competitors: the GEO Rankings tab's table for the period, with changes */}
      {d.competitors.length > 0 && (
        <section className="rpt-page">
          <SectionHeader
            n={++n}
            title="Competitors"
            sub={`The most mentioned brands in AI answers in ${P}${competitorsCompared ? `, compared with ${c.phrase}` : ""}.`}
          />
          <Table>
            <thead className="bg-[#FAF5F5]">
              <tr>
                <th className={th}>Rank</th>
                <th className={th}>Brand</th>
                <th className={thR}>Position</th>
                {competitorsCompared && <th className={thR}>Change</th>}
                <th className={thR}>Visibility</th>
                {competitorsCompared && <th className={thR}>Change</th>}
                <th className={thR}>Share of Voice</th>
                {competitorsCompared && <th className={thR}>Change</th>}
              </tr>
            </thead>
            <tbody>
              {d.competitors.map((row) => (
                <tr key={row.name} className={`border-t border-[#F0E6E6] ${row.isClient ? "bg-[#FDECEC] font-semibold" : ""}`}>
                  <td className={`${td} tabular-nums text-zinc-500`}>{row.rank != null ? `#${row.rank}` : "n/a"}</td>
                  <td className={td}>{row.name}</td>
                  <td className={tdR}>{fig(row.current, "position")}</td>
                  {competitorsCompared && (
                    <td className={tdR}>
                      <Change cur={row.current?.position} prev={row.previous?.position} kind="rank" />
                    </td>
                  )}
                  <td className={tdR}>{fig(row.current, "visibilityPct")}</td>
                  {competitorsCompared && (
                    <td className={tdR}>
                      <Change cur={row.current?.visibilityPct} prev={row.previous?.visibilityPct} kind="pts" />
                    </td>
                  )}
                  <td className={tdR}>{fig(row.current, "sharePct")}</td>
                  {competitorsCompared && (
                    <td className={tdR}>
                      <Change cur={row.current?.sharePct} prev={row.previous?.sharePct} kind="pts" />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            Rank is by mentions in {P}. Position is the brand&apos;s average place in the answers that list it (lower is
            better). Visibility is the share of AI answers that mention the brand. Share of Voice is the brand&apos;s share
            of all brand mentions.
            {isBenchmark && competitorsCompared
              ? ` Changes are from the ${c.source} benchmark: ${brand}'s from its own figures there (which have no Share of Voice for ${brand}), and other brands' from its top ${c.competitors?.length ?? 0} competitors, so brands outside that list have none (n/a).`
              : ""}
          </p>
          <Takeaway text={t.competitors} />
          {/* The benchmark's own competitor list (and how its websites matched tracked brands) is
              still saved with the report (compare.competitors) and drives the changes above; the
              user asked for the table itself to be left out of the report (2026-11-17). */}
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
              prev={citingThen != null ? fmtPct(citingThen) : null}
              diff={change(d.citations.current.ownSitePct, citingThen, "pts")}
              then={then}
              missing={missing}
            />
            <StatCard
              label="Live Search Answers"
              value={fmtInt(d.citations.current.answers)}
              prev={d.citations.previous ? fmtInt(d.citations.previous.answers) : null}
              diff={change(d.citations.current.answers, d.citations.previous?.answers, "count")}
              then={then}
              missing={missing}
            />
            <StatCard label="Sites Cited" value={fmtInt(d.citations.current.sitesCited)} prev={null} diff={null} then={then} missing={`In ${P}`} />
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
                      <Change cur={s.sharePct} prev={s.previousSharePct} kind="pts" />
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
                    <th className={thR}>{trafficLabel}</th>
                    <th className={thR}>{P}</th>
                    <th className={thR}>Change</th>
                  </tr>
                </thead>
                <tbody>
                  <TrafficRow label="AI Assistant channel" cur={d.traffic.current.aiAssistant} prev={prevTraffic?.aiAssistant} />
                  <TrafficRow label="Referrals from AI platforms" cur={d.traffic.current.referralAi} prev={prevTraffic?.referralAi} />
                  <TrafficRow label="Unassigned visits from AI platforms" cur={d.traffic.current.unassignedAi} prev={prevTraffic?.unassignedAi} />
                  <TrafficRow label="Measured AI visits, total" cur={d.traffic.current.measuredAiTotal} prev={prevTraffic?.measuredAiTotal} />
                  <TrafficRow label="All website sessions" cur={d.traffic.current.sessions} prev={prevTraffic?.sessions} />
                  {d.traffic.current.gscClicks != null && (
                    <TrafficRow label="Google Search clicks" cur={d.traffic.current.gscClicks} prev={prevTraffic?.gscClicks} />
                  )}
                </tbody>
              </Table>
              {(isBenchmark || c.kind === "firstCrawl") && c.trafficPeriod && (
                <p className="mt-2 text-[11px] text-zinc-500">
                  {c.trafficPeriod.label} is the {d.traffic.current.daysInPeriod} days up to {c.phrase}.
                </p>
              )}
              {trafficNote && <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-900">{trafficNote}</p>}
              <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                Direct visits arrive with no referrer, so AI visits among them can&apos;t be measured. Industry research
                puts 21% to 47% of Direct visits as AI-referred, which would mean about{" "}
                {fmtInt(d.traffic.current.directAiEstimate.low)} to {fmtInt(d.traffic.current.directAiEstimate.high)} of{" "}
                {P}&apos;s {fmtInt(d.traffic.current.direct)} Direct visits. That range is an estimate, not a
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
