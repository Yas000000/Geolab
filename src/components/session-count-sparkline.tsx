"use client";

import { useState } from "react";

export interface SessionCountPoint {
  key: string;
  dateLabel: string;
  value: number;
}

const WIDTH = 400;
const HEIGHT = 120;
const PADDING = { top: 12, right: 8, bottom: 20, left: 8 };
const INNER_WIDTH = WIDTH - PADDING.left - PADDING.right;
const INNER_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

/**
 * Sibling to VisibilityTrendChart, not a generalized version of it --
 * that component is hardcoded to a 0-100% scale, which doesn't fit raw
 * session counts (can run into the thousands/millions). Same hand-rolled
 * SVG pattern (hover tooltip, area fill, rounded line), dynamic y-max and
 * toLocaleString() formatting instead.
 */
export function SessionCountSparkline({ points, color = "#2563eb" }: { points: SessionCountPoint[]; color?: string }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-md border border-zinc-100 bg-zinc-50 text-xs text-zinc-400 dark:border-zinc-900 dark:bg-zinc-900/40 dark:text-zinc-600">
        No data in range
      </div>
    );
  }

  const maxValue = Math.max(1, ...points.map((p) => p.value));
  const xFor = (i: number) =>
    points.length === 1 ? PADDING.left + INNER_WIDTH / 2 : PADDING.left + (i / (points.length - 1)) * INNER_WIDTH;
  const yFor = (v: number) => PADDING.top + INNER_HEIGHT - (v / maxValue) * INNER_HEIGHT;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(p.value)}`).join(" ");
  const areaPath =
    `M ${xFor(0)} ${PADDING.top + INNER_HEIGHT} ` +
    points.map((p, i) => `L ${xFor(i)} ${yFor(p.value)}`).join(" ") +
    ` L ${xFor(points.length - 1)} ${PADDING.top + INNER_HEIGHT} Z`;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" style={{ height: HEIGHT }}>
        {points.length > 1 && <path d={areaPath} fill={color} fillOpacity={0.08} stroke="none" />}
        {points.length > 1 && (
          <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        )}
        {points.map((p, i) => (
          <circle
            key={p.key}
            cx={xFor(i)}
            cy={yFor(p.value)}
            r={hoverIdx === i ? 4.5 : 2.5}
            fill={color}
            stroke="white"
            strokeWidth={1.5}
            className="cursor-pointer"
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
          />
        ))}
      </svg>

      {hoverIdx !== null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          style={{
            left: `${(xFor(hoverIdx) / WIDTH) * 100}%`,
            top: `${(yFor(points[hoverIdx].value) / HEIGHT) * 100}%`,
          }}
        >
          <div className="font-medium text-zinc-900 dark:text-zinc-100">{points[hoverIdx].value.toLocaleString()}</div>
          <div className="text-zinc-500 dark:text-zinc-400">{points[hoverIdx].dateLabel}</div>
        </div>
      )}
    </div>
  );
}
