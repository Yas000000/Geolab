"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarMonth } from "@/components/date-range-picker";
import { parseISODate, toISODate } from "@/lib/date-range";
import { periodLabel } from "@/lib/report-period";

export interface DayRange {
  start: string; // "YYYY-MM-DD"
  end: string;
}

/**
 * A controlled day-range picker for the Reports tab: the same calendar as the
 * Rankings date picker, but it hands the range back through onChange instead
 * of writing it to the URL. Click a start day, then an end day (or a quick
 * pick), then Apply.
 */
export function ReportRangePicker({
  value,
  onChange,
  presets = [],
  disabled = false,
  label,
}: {
  value: DayRange | null;
  onChange: (range: DayRange) => void;
  presets?: { key: string; label: string; period: DayRange }[];
  disabled?: boolean;
  label: string; // what the range is for, e.g. "Report period"
}) {
  const [open, setOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState<Date | null>(null);
  const [pendingEnd, setPendingEnd] = useState<Date | null>(null);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);
  const [visibleMonth, setVisibleMonth] = useState(() => new Date());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function show(range: DayRange | null) {
    const s = range ? parseISODate(range.start) : null;
    setPendingStart(s);
    setPendingEnd(range ? parseISODate(range.end) : null);
    // Open on the start's month; with nothing picked, on last month and this month.
    const anchor = s ?? new Date();
    setVisibleMonth(new Date(anchor.getFullYear(), anchor.getMonth() - (s ? 0 : 1), 1));
  }

  function toggle() {
    if (!open) show(value);
    setOpen((v) => !v);
  }

  function handleDayClick(d: Date) {
    if (!pendingStart || pendingEnd) {
      setPendingStart(d);
      setPendingEnd(null);
    } else if (d.getTime() < pendingStart.getTime()) {
      setPendingEnd(pendingStart);
      setPendingStart(d);
    } else {
      setPendingEnd(d);
    }
  }

  function apply() {
    if (!pendingStart) return;
    onChange({ start: toISODate(pendingStart), end: toISODate(pendingEnd ?? pendingStart) });
    setOpen(false);
  }

  const pending = pendingStart ? { start: toISODate(pendingStart), end: toISODate(pendingEnd ?? pendingStart) } : null;
  const secondMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
  const navBtn = "rounded px-1.5 py-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${value ? periodLabel(value.start, value.end) : "not picked"}`}
        className="flex min-w-56 items-center justify-between gap-3 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
      >
        <span>{value ? periodLabel(value.start, value.end) : "Pick days"}</span>
        <span className="text-zinc-400" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        // Below md: a full-width sheet with one month and a backdrop (inside
        // containerRef, so it closes the sheet itself), like the Rankings picker.
        <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={() => setOpen(false)} aria-hidden="true" />
      )}
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="fixed inset-x-4 top-4 z-30 flex max-h-[calc(100dvh-2rem)] flex-col overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-xl md:absolute md:inset-x-auto md:top-auto md:left-0 md:z-20 md:w-max md:mt-2 md:max-h-none md:flex-row md:overflow-visible dark:border-zinc-700 dark:bg-zinc-900"
        >
          <div className="border-b border-zinc-200 p-4 md:border-r md:border-b-0 dark:border-zinc-800">
            <div className="mb-2 flex items-center justify-between text-zinc-500 dark:text-zinc-400">
              <div className="flex gap-1">
                <button type="button" aria-label="Previous year" onClick={() => setVisibleMonth((m) => new Date(m.getFullYear() - 1, m.getMonth(), 1))} className={navBtn}>
                  «
                </button>
                <button type="button" aria-label="Previous month" onClick={() => setVisibleMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))} className={navBtn}>
                  ‹
                </button>
              </div>
              <div className="flex gap-1">
                <button type="button" aria-label="Next month" onClick={() => setVisibleMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))} className={navBtn}>
                  ›
                </button>
                <button type="button" aria-label="Next year" onClick={() => setVisibleMonth((m) => new Date(m.getFullYear() + 1, m.getMonth(), 1))} className={navBtn}>
                  »
                </button>
              </div>
            </div>
            <div className="flex justify-center gap-6" onMouseLeave={() => setHoverDate(null)}>
              <CalendarMonth
                monthDate={visibleMonth}
                start={pendingStart}
                end={pendingEnd}
                hoverEnd={hoverDate}
                onDayClick={handleDayClick}
                onDayHover={setHoverDate}
              />
              <div className="hidden md:block">
                <CalendarMonth
                  monthDate={secondMonth}
                  start={pendingStart}
                  end={pendingEnd}
                  hoverEnd={hoverDate}
                  onDayClick={handleDayClick}
                  onDayHover={setHoverDate}
                />
              </div>
            </div>
          </div>

          <div className="w-full p-4 md:w-60">
            {presets.length > 0 && (
              <>
                <div className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Quick picks</div>
                <div className="mb-4 flex flex-col gap-1">
                  {presets.map((p) => {
                    const active = pending?.start === p.period.start && pending?.end === p.period.end;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => show(p.period)}
                        aria-pressed={active}
                        className={`rounded-md px-3 py-1.5 text-left text-sm ${
                          active
                            ? "bg-brand text-white"
                            : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Selected</div>
            <div className="mb-4 text-sm text-zinc-900 dark:text-zinc-100">
              {pending ? periodLabel(pending.start, pending.end) : "Click a start day"}
              {pendingStart && !pendingEnd && <div className="text-xs text-zinc-500 dark:text-zinc-400">Now click an end day, or Apply for one day.</div>}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={apply}
                disabled={!pendingStart}
                className="flex-1 rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
