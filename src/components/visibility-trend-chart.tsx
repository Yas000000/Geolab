"use client";

import { useState } from "react";
import { labelStride, useChartWidth } from "@/lib/use-chart-width";

export interface TrendPoint {
  runId: string;
  dateLabel: string;
  value: number; // 0-100
  isBenchmark?: boolean; // a historical baseline point (see benchmark-import.ts), not a tracked run
}

const BENCHMARK_COLOR = "#a1a1aa"; // zinc-400 -- visually distinct from the real-data accent blue

const ACCENT = "#2563eb";
const HEIGHT = 200;
const PADDING = { top: 16, right: 16, bottom: 28, left: 36 };
const INNER_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

export function VisibilityTrendChart({ points }: { points: TrendPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [plotRef, width] = useChartWidth();

  if (points.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-600">
        No completed runs yet.
      </div>
    );
  }

  const innerWidth = width - PADDING.left - PADDING.right;
  const xFor = (i: number) =>
    points.length === 1
      ? PADDING.left + innerWidth / 2
      : PADDING.left + (i / (points.length - 1)) * innerWidth;
  const yFor = (v: number) => PADDING.top + INNER_HEIGHT - (Math.max(0, Math.min(100, v)) / 100) * INNER_HEIGHT;
  const colHalf = points.length === 1 ? innerWidth / 2 : innerWidth / (points.length - 1) / 2;
  const stride = labelStride(points.length, innerWidth);
  const last = points.length - 1;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(p.value)}`).join(" ");
  const areaPath =
    `M ${xFor(0)} ${PADDING.top + INNER_HEIGHT} ` +
    points.map((p, i) => `L ${xFor(i)} ${yFor(p.value)}`).join(" ") +
    ` L ${xFor(last)} ${PADDING.top + INNER_HEIGHT} Z`;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div ref={plotRef} className="relative">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="w-full"
          style={{ height: HEIGHT }}
          data-chart="visibility-trend"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {[0, 50, 100].map((v) => (
            <g key={v}>
              <line
                x1={PADDING.left}
                x2={width - PADDING.right}
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

          {points.map((p, i) => {
            const r = hoverIdx === i ? 5.5 : 4;
            return (
              <g key={p.runId}>
                {p.isBenchmark ? (
                  <rect
                    x={xFor(i) - r}
                    y={yFor(p.value) - r}
                    width={r * 2}
                    height={r * 2}
                    fill="white"
                    stroke={BENCHMARK_COLOR}
                    strokeWidth={2}
                    transform={`rotate(45 ${xFor(i)} ${yFor(p.value)})`}
                    className="dark:fill-zinc-950"
                  />
                ) : (
                  <circle
                    cx={xFor(i)}
                    cy={yFor(p.value)}
                    r={hoverIdx === i ? 5 : 3.5}
                    fill={ACCENT}
                    stroke="white"
                    strokeWidth={1.5}
                  />
                )}
                {(last - i) % stride === 0 && (
                  <text x={xFor(i)} y={HEIGHT - 8} textAnchor="middle" className="fill-zinc-400 text-[10px] dark:fill-zinc-600">
                    {p.dateLabel}
                  </text>
                )}
              </g>
            );
          })}

          {/* Hit targets: one column per point, far wider than the dots, so a
              tap on a phone lands without aiming at a 7px circle. */}
          {points.map((p, i) => (
            <rect
              key={p.runId}
              x={xFor(i) - colHalf}
              y={0}
              width={colHalf * 2}
              height={HEIGHT}
              fill="transparent"
              className="cursor-pointer"
              onMouseEnter={() => setHoverIdx(i)}
              onClick={() => setHoverIdx(i)}
            />
          ))}
        </svg>

        {hoverIdx !== null && (
          <div
            className={`pointer-events-none absolute z-10 -translate-y-[calc(100%+8px)] whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${
              hoverIdx === 0 && points.length > 1
                ? "-translate-x-2"
                : hoverIdx === last && points.length > 1
                  ? "-translate-x-[calc(100%-8px)]"
                  : "-translate-x-1/2"
            }`}
            style={{ left: xFor(hoverIdx), top: yFor(points[hoverIdx].value) }}
          >
            <div className="font-medium text-zinc-900 dark:text-zinc-100">
              {points[hoverIdx].value.toFixed(0)}%
              {points[hoverIdx].isBenchmark && (
                <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-600">(baseline)</span>
              )}
            </div>
            <div className="text-zinc-500 dark:text-zinc-400">{points[hoverIdx].dateLabel}</div>
          </div>
        )}
      </div>
    </div>
  );
}
