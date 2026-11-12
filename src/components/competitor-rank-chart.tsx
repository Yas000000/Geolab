"use client";

import { useState } from "react";

// Bump chart for the Rankings page's Competitors section: each brand's rank
// in each crawl, #1 at the top. Ranks are computed server-side (rankings
// page) from mention counts within that one crawl, ties sharing a rank.

export interface RankPoint {
  rank: number;
  mentions: number;
}

export interface RankSeries {
  key: string;
  name: string;
  isClientBrand: boolean;
  points: (RankPoint | null)[]; // one per crawl; null = not mentioned in that crawl
}

export interface RankCrawl {
  runId: string;
  dateLabel: string;
  isTraining: boolean; // Training Search (no web access) -- tagged so it isn't read as a Live crawl
}

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

export function CompetitorRankChart({ crawls, series }: { crawls: RankCrawl[]; series: RankSeries[] }) {
  const [hoverCrawl, setHoverCrawl] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  if (crawls.length === 0 || series.length === 0) return null;

  const slot = slotsFor(series);
  const allRanks = series.flatMap((s) => s.points.filter((p): p is RankPoint => p != null).map((p) => p.rank));
  const deepest = Math.max(1, ...allRanks);
  const hasOverflow = deepest > MAX_SHOWN_RANK;
  const shownRows = Math.max(2, Math.min(deepest, MAX_SHOWN_RANK)) + (hasOverflow ? 1 : 0);
  const height = PADDING.top + (shownRows - 1) * ROW_H + PADDING.bottom;
  const innerWidth = WIDTH - PADDING.left - PADDING.right;

  const xFor = (i: number) =>
    crawls.length === 1 ? PADDING.left + innerWidth / 2 : PADDING.left + (i / (crawls.length - 1)) * innerWidth;
  // Row index 0 = #1. Anything below MAX_SHOWN_RANK shares the last (">10") row.
  const rowFor = (rank: number) => (rank > MAX_SHOWN_RANK ? shownRows - 1 : rank - 1);
  const yFor = (rank: number) => PADDING.top + rowFor(rank) * ROW_H;
  const rowLabels = Array.from({ length: shownRows }, (_, i) =>
    hasOverflow && i === shownRows - 1 ? `>${MAX_SHOWN_RANK}` : `#${i + 1}`,
  );

  const colHalf = crawls.length === 1 ? innerWidth / 2 : innerWidth / (crawls.length - 1) / 2;
  const dimmed = (key: string) => highlight != null && highlight !== key;

  // Draw order: competitors first, client last so its line sits on top.
  const drawOrder = [...series].sort((a, b) => Number(a.isClientBrand) - Number(b.isClientBrand));

  const hovered =
    hoverCrawl == null
      ? []
      : series
          .map((s) => ({ s, p: s.points[hoverCrawl] }))
          .sort((a, b) => (a.p?.rank ?? Infinity) - (b.p?.rank ?? Infinity));

  return (
    <div className="mb-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
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
          aria-label="Competitor rank in each crawl"
          onMouseLeave={() => setHoverCrawl(null)}
        >
          {rowLabels.map((label, i) => (
            <g key={label}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={PADDING.top + i * ROW_H}
                y2={PADDING.top + i * ROW_H}
                stroke="currentColor"
                className="text-zinc-100 dark:text-zinc-900"
                strokeWidth={1}
              />
              <text
                x={PADDING.left - 10}
                y={PADDING.top + i * ROW_H}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-zinc-400 text-[10px] tabular-nums dark:fill-zinc-600"
              >
                {label}
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
              y2={PADDING.top + (shownRows - 1) * ROW_H + 6}
              stroke="currentColor"
              className="text-zinc-300 dark:text-zinc-700"
              strokeWidth={1}
            />
          )}

          {drawOrder.map((s) => {
            // Break the line where the brand wasn't mentioned in a crawl.
            const segments: string[] = [];
            let current = "";
            s.points.forEach((p, i) => {
              if (!p) {
                if (current) segments.push(current);
                current = "";
                return;
              }
              current += `${current ? "L" : "M"} ${xFor(i)} ${yFor(p.rank)} `;
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
                {s.points.map((p, i) =>
                  p ? (
                    <circle
                      key={i}
                      cx={xFor(i)}
                      cy={yFor(p.rank)}
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
                ({crawls[hoverCrawl].isTraining ? "Training Search" : "Live Search"})
              </span>
            </div>
            {hovered.map(({ s, p }) => (
              <div key={s.key} className="flex items-center gap-2 py-px">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${slot.get(s.key)!.bg}`} />
                <span className={`flex-1 ${s.isClientBrand ? "font-semibold text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}`}>
                  {s.name}
                </span>
                <span className="tabular-nums text-zinc-900 dark:text-zinc-100">{p ? `#${p.rank}` : "not mentioned"}</span>
                {p && (
                  <span className="pl-1 text-right tabular-nums text-zinc-400 dark:text-zinc-500">
                    {p.mentions} mention{p.mentions === 1 ? "" : "s"}
                  </span>
                )}
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
                <th className="py-1 pr-4 font-medium">Brand</th>
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
                  {s.points.map((p, i) => (
                    <td key={i} className="py-1 pr-4 text-right text-zinc-700 dark:text-zinc-300">
                      {p ? `#${p.rank} (${p.mentions})` : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
