"use client";

import { useState } from "react";

export interface TrendPoint {
  runId: string;
  dateLabel: string;
  value: number; // 0-100
}

const ACCENT = "#2563eb";
const WIDTH = 800;
const HEIGHT = 200;
const PADDING = { top: 16, right: 16, bottom: 28, left: 36 };
const INNER_WIDTH = WIDTH - PADDING.left - PADDING.right;
const INNER_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

export function VisibilityTrendChart({ points }: { points: TrendPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-600">
        No completed runs yet.
      </div>
    );
  }

  const xFor = (i: number) =>
    points.length === 1
      ? PADDING.left + INNER_WIDTH / 2
      : PADDING.left + (i / (points.length - 1)) * INNER_WIDTH;
  const yFor = (v: number) => PADDING.top + INNER_HEIGHT - (Math.max(0, Math.min(100, v)) / 100) * INNER_HEIGHT;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(p.value)}`).join(" ");
  const areaPath =
    `M ${xFor(0)} ${PADDING.top + INNER_HEIGHT} ` +
    points.map((p, i) => `L ${xFor(i)} ${yFor(p.value)}`).join(" ") +
    ` L ${xFor(points.length - 1)} ${PADDING.top + INNER_HEIGHT} Z`;

  return (
    <div className="relative rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" style={{ height: 200 }}>
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={yFor(v)}
              y2={yFor(v)}
              stroke="currentColor"
              className="text-zinc-100 dark:text-zinc-900"
              strokeWidth={1}
            />
            <text
              x={PADDING.left - 8}
              y={yFor(v)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-zinc-400 text-[10px] tabular-nums dark:fill-zinc-600"
            >
              {v}%
            </text>
          </g>
        ))}

        {points.length > 1 && <path d={areaPath} fill={ACCENT} fillOpacity={0.08} stroke="none" />}
        {points.length > 1 && (
          <path d={linePath} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        )}

        {points.map((p, i) => (
          <g key={p.runId}>
            <circle
              cx={xFor(i)}
              cy={yFor(p.value)}
              r={hoverIdx === i ? 5 : 3.5}
              fill={ACCENT}
              stroke="white"
              strokeWidth={1.5}
              className="cursor-pointer"
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
            />
            <text x={xFor(i)} y={HEIGHT - 8} textAnchor="middle" className="fill-zinc-400 text-[10px] dark:fill-zinc-600">
              {p.dateLabel}
            </text>
          </g>
        ))}
      </svg>

      {hoverIdx !== null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-[calc(100%+8px)] rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          style={{
            left: `${(xFor(hoverIdx) / WIDTH) * 100}%`,
            top: `${(yFor(points[hoverIdx].value) / HEIGHT) * 100}%`,
          }}
        >
          <div className="font-medium text-zinc-900 dark:text-zinc-100">
            {points[hoverIdx].value.toFixed(0)}%
          </div>
          <div className="text-zinc-500 dark:text-zinc-400">{points[hoverIdx].dateLabel}</div>
        </div>
      )}
    </div>
  );
}
