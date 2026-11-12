"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * Width in CSS px of the element `ref` is attached to, kept current with a
 * ResizeObserver. Charts draw their SVG at this real width (viewBox = width)
 * instead of scaling a fixed 800px drawing to fit, which on a phone shrank
 * axis text to ~4px. `fallback` covers the server render and the first paint.
 */
export function useChartWidth<T extends HTMLElement = HTMLDivElement>(fallback = 800) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Which x-axis labels to draw so neighbours stay at least `minGap` px apart.
 * Counts back from the latest point so the most recent label always shows.
 */
export function labelStride(count: number, innerWidth: number, minGap = 52) {
  if (count < 2) return 1;
  const spacing = innerWidth / (count - 1);
  return Math.max(1, Math.ceil(minGap / spacing));
}
