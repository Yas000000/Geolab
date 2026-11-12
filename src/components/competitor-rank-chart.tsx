"use client";

import { useState } from "react";

// Chart for the Rankings page's Competitors section: one line per brand
// across crawls, for a metric picked from a dropdown -- Rank (a bump chart,
// #1 on top), or the Competitors table's Position, Visibility and Share of
// Voice computed per crawl. All numbers are computed server-side (rankings
// page) with the table's own formulas, scoped to one crawl.

export interface BrandCrawlPoint {
  mentions: number; // 0 = not mentioned in this crawl
  rank: number | null; // rank by mentions within the crawl (ties share a rank); null when not mentioned
  avgPosition: number | null; // average list position in the answers that mentioned it
  visibilityPct: number; // mentions / answers in the crawl
  sovPct: number; // mentions / all brands' mentions in the crawl
}

export interface RankSeries {
  key: string;
  name: string;
  isClientBrand: boolean;
  points: BrandCrawlPoint[]; // one per crawl
}

export interface RankCrawl {
  runId: string;
  dateLabel: string;
  isTraining: boolean; // Training Search (no web access) -- tagged so it isn't read as a Live crawl
}

type Metric = "rank" | "position" | "visibility" | "sov";

interface MetricSpec {
  label: string;
  caption: string;
  lowerIsBetter: boolean;
  value: (p: BrandCrawlPoint) => number | null; // null = no value (line breaks)
  format: (v: number) => string;
}

const METRICS: Record<Metric, MetricSpec> = {
  rank: {
    label: "Rank",
    caption: "Each brand's rank in each crawl by number of mentions, #1 at the top.",
    lowerIsBetter: true,
    value: (p) => p.rank,
    format: (v) => `#${v}`,
  },
  position: {
    label: "Position",
    caption:
      "Each brand's average position in the answers that mentioned it, per crawl. Lower is better, so the top of the chart is best.",
    lowerIsBetter: true,
    value: (p) => p.avgPosition,
    format: (v) => v.toFixed(1),
  },
  visibility: {
    label: "Visibility",
    caption: "Share of each crawl's answers that mentioned the brand.",
    lowerIsBetter: false,
    value: (p) => p.visibilityPct,
    format: (v) => `${v.toFixed(1)}%`,
  },
  sov: {
    label: "Share of Voice",
    caption: "Each brand's share of all brand mentions in each crawl.",
    lowerIsBetter: false,
    value: (p) => p.sovPct,
    format: (v) => `${v.toFixed(1)}%`,
  },
};
const METRIC_ORDER: Metric[] = ["rank", "position", "visibility", "sov"];

// Reference categorical palette (dataviz skill), slots 1-6 in fixed order.
// Validated 2026-11-12 on this app's surfaces: light #ffffff and dark
// zinc-950 #09090b, all checks pass (light: aqua/yellow/magenta < 3:1, so the
// tooltip and table view carry identity too). The client brand always takes
// slot 1; competitors follow in Competitors-table order. Literal class
// strings so Tailwind generates them.
const SLOTS = [
  { stroke: "stroke-[#2a78d6] dark:stroke-[#3987e5]", fill: "fill-[#2a78d6] dark:fill-[#3987e5]", bg: "bg-[#2a78d6] dark:bg-[#3987e5]" },
  { stroke: "stroke-[#eb6834] dark:stroke-[#d95926]", fill: "fill-[#eb6834] dark:fill-[#d95926]", bg: "bg-[#eb6834] dark:bg-[#d95926]" },
  { stroke: "stroke-[#1baf7a] dark:stroke-[#199e70]", fill: "fill-[#1baf7a] dark:fill-[#199e70]", bg: "bg-[#1baf7a] dark:bg-[#199e70]" },
  { stroke: "stroke-[#eda100] dark:stroke-[#c98500]", fill: "fill-[#eda100] dark:fill-[#c98500]", bg: "bg-[#eda100] dark:bg-[#c98500]" },
  { stroke: "stroke-[#e87ba4] dark:stroke-[#d55181]", fill: "fill-[#e87ba4] dark:fill-[#d55181]", bg: "bg-[#e87ba4] dark:bg-[#d55181]" },
  { stroke: "stroke-[#008300] dark:stroke-[#008300]", fill: "fill-[#008300] dark:fill-[#008300]", bg: "bg-[#008300] dark:bg-[#008300]" },
];

const MAX_SHOWN_RANK = 10; // ranks below this sit on one ">10" row so one outlier can't squash the chart
const WIDTH = 800;
const ROW_H = 26;
const CONTINUOUS_H = MAX_SHOWN_RANK * ROW_H; // plot height for Position / Visibility / Share of Voice
const PADDING = { top: 14, right: 28, bottom: 40, left: 44 };

function slotsFor(series: RankSeries[]) {
  const map = new Map<string, (typeof SLOTS)[number]>();
  let next = 1;
  for (const s of series) {
    if (s.isClientBrand) map.set(s.key, SLOTS[0]);
  }
  for (const s of series) {
    if (!map.has(s.key)) map.set(s.key, SLOTS[Math.min(next++, SLOTS.length - 1)]);
  }
  return map;
}

interface Scale {
  innerH: number;
  yFor: (v: number) => number;
  ticks: { y: number; label: string }[];
}

function buildScale(metric: Metric, values: number[]): Scale {
  const top = PADDING.top;
  if (metric === "rank") {
    const deepest = Math.max(1, ...values);
    const hasOverflow = deepest > MAX_SHOWN_RANK;
    const rows = Math.max(2, Math.min(deepest, MAX_SHOWN_RANK)) + (hasOverflow ? 1 : 0);
    return {
      innerH: (rows - 1) * ROW_H,
      yFor: (v) => top + (v > MAX_SHOWN_RANK ? rows - 1 : v - 1) * ROW_H,
      ticks: Array.from({ length: rows }, (_, i) => ({
        y: top + i * ROW_H,
        label: hasOverflow && i === rows - 1 ? `>${MAX_SHOWN_RANK}` : `#${i + 1}`,
      })),
    };
  }
  if (metric === "position") {
    // Inverted like rank: position 1 at the top.
    const maxV = Math.max(2, Math.ceil(Math.max(1, ...values)));
    const step = maxV > 10 ? 2 : 1;
    const yFor = (v: number) => top + ((v - 1) / (maxV - 1)) * CONTINUOUS_H;
    const ticks = [];
    for (let t = 1; t <= maxV; t += step) ticks.push({ y: yFor(t), label: String(t) });
    return { innerH: CONTINUOUS_H, yFor, ticks };
  }
  // Percentages: 0 at the bottom, rounded-up max at the top.
  const maxV = Math.max(0, ...values);
  const step = maxV <= 20 ? 5 : maxV <= 50 ? 10 : 20;
  const ceiling = Math.min(100, Math.max(step, Math.ceil(maxV / step) * step));
  const yFor = (v: number) => top + CONTINUOUS_H - (v / ceiling) * CONTINUOUS_H;
  const ticks = [];
  for (let t = 0; t <= ceiling; t += step) ticks.push({ y: yFor(t), label: `${t}%` });
  return { innerH: CONTINUOUS_H, yFor, ticks };
}

export function CompetitorRankChart({
  crawls,
  series,
  brandCount,
}: {
  crawls: RankCrawl[];
  series: RankSeries[];
  brandCount: number;
}) {
  const [metric, setMetric] = useState<Metric>("rank");
  const [hoverCrawl, setHoverCrawl] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  if (crawls.length === 0 || series.length === 0) return null;

  const spec = METRICS[metric];
  const slot = slotsFor(series);
  const valuesOf = (s: RankSeries) => s.points.map((p) => spec.value(p));
  const allValues = series.flatMap((s) => valuesOf(s).filter((v): v is number => v != null));
  const scale = buildScale(metric, allValues);
  const height = PADDING.top + scale.innerH + PADDING.bottom;
  const innerWidth = WIDTH - PADDING.left - PADDING.right;

  const xFor = (i: number) =>
    crawls.length === 1 ? PADDING.left + innerWidth / 2 : PADDING.left + (i / (crawls.length - 1)) * innerWidth;
  const colHalf = crawls.length === 1 ? innerWidth / 2 : innerWidth / (crawls.length - 1) / 2;
  const dimmed = (key: string) => highlight != null && highlight !== key;

  // Draw order: competitors first, client last so its line sits on top.
  const drawOrder = [...series].sort((a, b) => Number(a.isClientBrand) - Number(b.isClientBrand));

  const better = (a: number | null, b: number | null) => {
    if (a == null) return b == null ? 0 : 1;
    if (b == null) return -1;
    return spec.lowerIsBetter ? a - b : b - a;
  };
  const hovered =
    hoverCrawl == null
      ? []
      : series
          .map((s) => ({ s, p: s.points[hoverCrawl], v: spec.value(s.points[hoverCrawl]) }))
          .sort((a, b) => better(a.v, b.v));

  return (
    <div className="mb-4">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <p className="min-w-0 text-xs text-zinc-500 sm:flex-1 dark:text-zinc-400">
          {spec.caption} Shows this range&apos;s top {brandCount} brands, plus you if you&apos;re outside them. The table
          below covers the whole range, so its numbers can differ from any single crawl. Hover the chart for each
          crawl&apos;s numbers.
        </p>
        <label className="flex min-w-0 shrink-0 items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          Show
          <select
            aria-label="Chart metric"
            value={metric}
            onChange={(e) => {
              setMetric(e.target.value as Metric);
              setHoverCrawl(null);
            }}
            className="min-w-0 max-w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          >
            {METRIC_ORDER.map((m) => (
              <option key={m} value={m}>
                {METRICS[m].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {series.map((s) => (
            <button
              key={s.key}
              type="button"
              onMouseEnter={() => setHighlight(s.key)}
              onMouseLeave={() => setHighlight(null)}
              onFocus={() => setHighlight(s.key)}
              onBlur={() => setHighlight(null)}
              className={`flex items-center gap-1.5 text-xs transition-opacity ${dimmed(s.key) ? "opacity-40" : ""}`}
            >
              <span className={`inline-block h-0.5 w-4 rounded-full ${slot.get(s.key)!.bg}`} />
              <span className={s.isClientBrand ? "font-semibold text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}>
                {s.name}
              </span>
              {s.isClientBrand && (
                <span className="rounded bg-blue-100 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                  You
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="relative">
          <svg
            viewBox={`0 0 ${WIDTH} ${height}`}
            className="h-auto w-full"
            role="img"
            aria-label={`Competitor ${spec.label.toLowerCase()} in each crawl`}
            data-chart="competitor-crawl-chart"
            onMouseLeave={() => setHoverCrawl(null)}
          >
            {scale.ticks.map((t) => (
              <g key={t.label}>
                <line
                  x1={PADDING.left}
                  x2={WIDTH - PADDING.right}
                  y1={t.y}
                  y2={t.y}
                  stroke="currentColor"
                  className="text-zinc-100 dark:text-zinc-900"
                  strokeWidth={1}
                />
                <text
                  x={PADDING.left - 10}
                  y={t.y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-zinc-400 text-[10px] tabular-nums dark:fill-zinc-600"
                >
                  {t.label}
                </text>
              </g>
            ))}

            {crawls.map((c, i) => (
              <text key={c.runId} x={xFor(i)} y={height - 20} textAnchor="middle" className="fill-zinc-400 text-[10px] dark:fill-zinc-600">
                {c.dateLabel}
                {c.isTraining && (
                  <tspan x={xFor(i)} dy={12} className="text-[9px]">
                    Training
                  </tspan>
                )}
              </text>
            ))}

            {hoverCrawl != null && (
              <line
                x1={xFor(hoverCrawl)}
                x2={xFor(hoverCrawl)}
                y1={PADDING.top - 6}
                y2={PADDING.top + scale.innerH + 6}
                stroke="currentColor"
                className="text-zinc-300 dark:text-zinc-700"
                strokeWidth={1}
              />
            )}

            {drawOrder.map((s) => {
              // Break the line where there's no value (Rank/Position when not mentioned).
              const values = valuesOf(s);
              const segments: string[] = [];
              let current = "";
              values.forEach((v, i) => {
                if (v == null) {
                  if (current) segments.push(current);
                  current = "";
                  return;
                }
                current += `${current ? "L" : "M"} ${xFor(i)} ${scale.yFor(v)} `;
              });
              if (current) segments.push(current);
              const cls = slot.get(s.key)!;
              return (
                <g key={s.key} className={`transition-opacity ${dimmed(s.key) ? "opacity-15" : ""}`}>
                  {segments.map((d, i) => (
                    <path
                      key={i}
                      d={d}
                      fill="none"
                      className={cls.stroke}
                      strokeWidth={s.isClientBrand ? 3 : 2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                  {values.map((v, i) =>
                    v != null ? (
                      <circle
                        key={i}
                        cx={xFor(i)}
                        cy={scale.yFor(v)}
                        r={s.isClientBrand ? 5 : 4}
                        className={`${cls.fill} stroke-white dark:stroke-zinc-950`}
                        strokeWidth={2}
                      />
                    ) : null,
                  )}
                </g>
              );
            })}

            {/* Hit targets: one column per crawl, wider than the marks. */}
            {crawls.map((c, i) => (
              <rect
                key={c.runId}
                x={xFor(i) - colHalf}
                y={0}
                width={colHalf * 2}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHoverCrawl(i)}
              />
            ))}
          </svg>

          {hoverCrawl != null && (
            <div
              className={`pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${
                hoverCrawl === 0 && crawls.length > 1
                  ? "translate-x-2"
                  : hoverCrawl === crawls.length - 1 && crawls.length > 1
                    ? "-translate-x-[calc(100%+8px)]"
                    : "-translate-x-1/2"
              }`}
              style={{ left: `${(xFor(hoverCrawl) / WIDTH) * 100}%` }}
            >
              <div className="mb-1 font-medium text-zinc-900 dark:text-zinc-100">
                {crawls[hoverCrawl].dateLabel} crawl
                <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-500">
                  ({crawls[hoverCrawl].isTraining ? "Training Search" : "Live Search"}) · {spec.label}
                </span>
              </div>
              {hovered.map(({ s, p, v }) => (
                <div key={s.key} className="flex items-center gap-2 py-px">
                  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${slot.get(s.key)!.bg}`} />
                  <span className={`flex-1 ${s.isClientBrand ? "font-semibold text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}`}>
                    {s.name}
                  </span>
                  <span className="tabular-nums text-zinc-900 dark:text-zinc-100">
                    {v != null ? spec.format(v) : "not mentioned"}
                  </span>
                  <span className="pl-1 text-right tabular-nums text-zinc-400 dark:text-zinc-500">
                    {p.mentions} mention{p.mentions === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
            View as table
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full tabular-nums">
              <thead className="text-left text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="py-1 pr-4 font-medium">{spec.label}</th>
                  {crawls.map((c) => (
                    <th key={c.runId} className="py-1 pr-4 text-right font-medium">
                      {c.dateLabel}
                      {c.isTraining ? " (Training)" : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {series.map((s) => (
                  <tr key={s.key}>
                    <td className={`py-1 pr-4 ${s.isClientBrand ? "font-semibold text-zinc-900 dark:text-zinc-100" : "text-zinc-700 dark:text-zinc-300"}`}>
                      {s.name}
                    </td>
                    {s.points.map((p, i) => {
                      const v = spec.value(p);
                      return (
                        <td key={i} className="py-1 pr-4 text-right text-zinc-700 dark:text-zinc-300">
                          {v != null ? spec.format(v) : "—"}
                          {metric === "rank" && v != null ? ` (${p.mentions})` : ""}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
}
