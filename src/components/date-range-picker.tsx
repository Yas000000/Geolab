"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  PRESETS,
  resolvePreset,
  toISODate,
  parseISODate,
  formatDisplayDate,
  type PresetKey,
  type CompareMode,
  type DateRange,
} from "@/lib/date-range";

const COMPARE_OPTIONS: { key: CompareMode; label: string }[] = [
  { key: "none", label: "None" },
  { key: "lastPeriod", label: "Last Period" },
  { key: "lastYear", label: "Last Year" },
  { key: "custom", label: "Custom" },
];

const DEFAULT_N_DAYS = 60;
const DEFAULT_N_MONTHS = 3;

function sameDay(a: Date | null, b: Date | null) {
  return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function inRange(d: Date, start: Date | null, end: Date | null) {
  if (!start || !end) return false;
  const t = d.getTime();
  const [lo, hi] = start.getTime() <= end.getTime() ? [start, end] : [end, start];
  return t >= lo.getTime() && t <= hi.getTime();
}

function CalendarMonth({
  monthDate,
  start,
  end,
  hoverEnd,
  onDayClick,
  onDayHover,
}: {
  monthDate: Date;
  start: Date | null;
  end: Date | null;
  hoverEnd: Date | null;
  onDayClick: (d: Date) => void;
  onDayHover: (d: Date) => void;
}) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = firstDay.getDay();
  const previewEnd = end ?? hoverEnd;

  const cells: (Date | null)[] = [
    ...Array(leadingBlanks).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
  ];

  return (
    <div>
      <div className="mb-2 text-center text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {monthDate.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="pb-1 font-medium text-zinc-400 dark:text-zinc-600">
            {d}
          </div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={i} />;
          const isStart = sameDay(d, start);
          const isEnd = sameDay(d, end) || (!end && sameDay(d, hoverEnd));
          const isInRange = inRange(d, start, previewEnd);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onDayClick(d)}
              onMouseEnter={() => onDayHover(d)}
              className={`h-7 w-7 rounded text-sm tabular-nums ${
                isStart || isEnd
                  ? "bg-blue-600 font-semibold text-white"
                  : isInRange
                    ? "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DropdownList<T extends string>({
  options,
  activeKey,
  onSelect,
  renderLabel,
}: {
  options: { key: T; label: string }[];
  activeKey: T | null;
  onSelect: (key: T) => void;
  renderLabel?: (opt: { key: T; label: string }) => React.ReactNode;
}) {
  return (
    <div className="max-h-64 overflow-y-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onSelect(opt.key)}
          className={`flex w-full items-center px-3 py-2 text-left text-sm ${
            activeKey === opt.key
              ? "bg-blue-600 text-white"
              : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
          }`}
        >
          {renderLabel ? renderLabel(opt) : opt.label}
        </button>
      ))}
    </div>
  );
}

export function DateRangePicker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const [visibleMonth, setVisibleMonth] = useState(() => new Date());
  const [preset, setPreset] = useState<PresetKey>("allTime");
  const [nDays, setNDays] = useState(DEFAULT_N_DAYS);
  const [nMonths, setNMonths] = useState(DEFAULT_N_MONTHS);
  const [pendingStart, setPendingStart] = useState<Date | null>(null);
  const [pendingEnd, setPendingEnd] = useState<Date | null>(null);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);
  const [presetListOpen, setPresetListOpen] = useState(false);

  const [compareMode, setCompareMode] = useState<CompareMode>("none");
  const [compareStart, setCompareStart] = useState<Date | null>(null);
  const [compareEnd, setCompareEnd] = useState<Date | null>(null);
  const [compareListOpen, setCompareListOpen] = useState(false);

  // Re-initialize pending state from the URL every time the popover opens,
  // so re-opening reflects what's actually applied, not a stale prior edit.
  function initFromUrl() {
    const urlPreset = (searchParams.get("preset") as PresetKey) || "allTime";
    const urlStart = searchParams.get("start");
    const urlEnd = searchParams.get("end");
    const urlN = Number(searchParams.get("n"));
    setPreset(urlPreset);
    if (urlPreset === "lastNDays" && urlN) setNDays(urlN);
    if (urlPreset === "lastNMonths" && urlN) setNMonths(urlN);
    if (urlStart && urlEnd) {
      const s = parseISODate(urlStart);
      const e = parseISODate(urlEnd);
      setPendingStart(s);
      setPendingEnd(e);
      setVisibleMonth(new Date(s.getFullYear(), s.getMonth(), 1));
    } else {
      setPendingStart(null);
      setPendingEnd(null);
      setVisibleMonth(new Date());
    }
    const urlCompare = (searchParams.get("compare") as CompareMode) || "none";
    setCompareMode(urlCompare);
    const cs = searchParams.get("compareStart");
    const ce = searchParams.get("compareEnd");
    setCompareStart(cs ? parseISODate(cs) : null);
    setCompareEnd(ce ? parseISODate(ce) : null);
  }

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  function togglePopover() {
    if (!open) initFromUrl();
    setOpen((v) => !v);
    setPresetListOpen(false);
    setCompareListOpen(false);
  }

  function selectPreset(key: PresetKey) {
    setPreset(key);
    setPresetListOpen(false);
    if (key === "allTime") {
      setPendingStart(null);
      setPendingEnd(null);
      return;
    }
    if (key === "custom") return; // let the calendar drive it
    const range = resolvePreset(key, { nDays, nMonths });
    if (range) {
      setPendingStart(range.start);
      setPendingEnd(range.end);
      setVisibleMonth(new Date(range.start.getFullYear(), range.start.getMonth(), 1));
    }
  }

  function handleDayClick(d: Date) {
    setPreset("custom");
    if (!pendingStart || (pendingStart && pendingEnd)) {
      setPendingStart(d);
      setPendingEnd(null);
      return;
    }
    if (d.getTime() < pendingStart.getTime()) {
      setPendingEnd(pendingStart);
      setPendingStart(d);
    } else {
      setPendingEnd(d);
    }
  }

  function applyRange() {
    const params = new URLSearchParams(searchParams.toString());
    if (pendingStart && pendingEnd) {
      params.set("start", toISODate(pendingStart));
      params.set("end", toISODate(pendingEnd));
      params.set("preset", preset);
      if (preset === "lastNDays") params.set("n", String(nDays));
      else if (preset === "lastNMonths") params.set("n", String(nMonths));
      else params.delete("n");
    } else {
      params.delete("start");
      params.delete("end");
      params.delete("preset");
      params.delete("n");
    }
    if (compareMode === "none") {
      params.delete("compare");
      params.delete("compareStart");
      params.delete("compareEnd");
    } else {
      params.set("compare", compareMode);
      if (compareMode === "custom" && compareStart && compareEnd) {
        params.set("compareStart", toISODate(compareStart));
        params.set("compareEnd", toISODate(compareEnd));
      } else {
        params.delete("compareStart");
        params.delete("compareEnd");
      }
    }
    const qs = params.toString();
    const target = qs ? `${pathname}?${qs}` : pathname;
    window.location.href = target;
  }

  // --- trigger button label, derived straight from the URL (not pending state) ---
  const appliedPreset = (searchParams.get("preset") as PresetKey) || "allTime";
  const appliedStart = searchParams.get("start");
  const appliedEnd = searchParams.get("end");
  const appliedN = Number(searchParams.get("n"));
  let triggerLabel = "All Time";
  if (appliedStart && appliedEnd) {
    if (appliedPreset === "custom") {
      triggerLabel = `${formatDisplayDate(parseISODate(appliedStart))} - ${formatDisplayDate(parseISODate(appliedEnd))}`;
    } else {
      const p = PRESETS.find((p) => p.key === appliedPreset);
      triggerLabel = p ? p.label.replace("{n}", String(appliedN || DEFAULT_N_DAYS)) : "Custom";
    }
  }

  const secondMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={togglePopover}
        className="flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
      >
        {triggerLabel}
        <span className="text-zinc-400">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 flex rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          <div className="border-r border-zinc-200 p-4 dark:border-zinc-800">
            <div className="mb-2 flex items-center justify-between text-zinc-500 dark:text-zinc-400">
              <div className="flex gap-1">
                <button type="button" onClick={() => setVisibleMonth((m) => new Date(m.getFullYear() - 1, m.getMonth(), 1))} className="px-1 text-xs">
                  «
                </button>
                <button type="button" onClick={() => setVisibleMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))} className="px-1 text-xs">
                  ‹
                </button>
              </div>
              <div className="flex gap-1">
                <button type="button" onClick={() => setVisibleMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))} className="px-1 text-xs">
                  ›
                </button>
                <button type="button" onClick={() => setVisibleMonth((m) => new Date(m.getFullYear() + 1, m.getMonth(), 1))} className="px-1 text-xs">
                  »
                </button>
              </div>
            </div>
            <div className="flex gap-6" onMouseLeave={() => setHoverDate(null)}>
              <CalendarMonth
                monthDate={visibleMonth}
                start={pendingStart}
                end={pendingEnd}
                hoverEnd={hoverDate}
                onDayClick={handleDayClick}
                onDayHover={setHoverDate}
              />
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

          <div className="w-72 p-4">
            <div className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Date Range</div>
            <div className="relative mb-3">
              <button
                type="button"
                onClick={() => setPresetListOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
              >
                {PRESETS.find((p) => p.key === preset)?.label.replace("{n}", String(preset === "lastNMonths" ? nMonths : nDays)) ?? "Custom"}
                <span className="text-zinc-400">⇅</span>
              </button>
              {presetListOpen && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1">
                  <DropdownList
                    options={PRESETS}
                    activeKey={preset}
                    onSelect={selectPreset}
                    renderLabel={(opt) =>
                      opt.key === "lastNDays" ? (
                        <span className="flex items-center gap-1.5">
                          Last
                          <input
                            type="number"
                            value={nDays}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setNDays(Number(e.target.value) || DEFAULT_N_DAYS)}
                            className="w-14 rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                          />
                          Days
                        </span>
                      ) : opt.key === "lastNMonths" ? (
                        <span className="flex items-center gap-1.5">
                          Last
                          <input
                            type="number"
                            value={nMonths}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setNMonths(Number(e.target.value) || DEFAULT_N_MONTHS)}
                            className="w-14 rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                          />
                          Months
                        </span>
                      ) : (
                        opt.label
                      )
                    }
                  />
                </div>
              )}
            </div>

            <div className="mb-4 flex gap-2">
              <input
                readOnly
                value={pendingStart ? toISODate(pendingStart) : ""}
                placeholder="Start"
                className="w-1/2 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
              />
              <input
                readOnly
                value={pendingEnd ? toISODate(pendingEnd) : ""}
                placeholder="End"
                className="w-1/2 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
              />
            </div>

            <div className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Compare To</div>
            <div className="relative mb-3">
              <button
                type="button"
                onClick={() => setCompareListOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
              >
                {COMPARE_OPTIONS.find((c) => c.key === compareMode)?.label}
                <span className="text-zinc-400">⇅</span>
              </button>
              {compareListOpen && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1">
                  <DropdownList
                    options={COMPARE_OPTIONS}
                    activeKey={compareMode}
                    onSelect={(key) => {
                      setCompareMode(key);
                      setCompareListOpen(false);
                    }}
                  />
                </div>
              )}
            </div>

            {compareMode === "custom" && (
              <div className="mb-4 flex gap-2">
                <input
                  type="date"
                  value={compareStart ? toISODate(compareStart) : ""}
                  onChange={(e) => setCompareStart(e.target.value ? parseISODate(e.target.value) : null)}
                  className="w-1/2 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
                />
                <input
                  type="date"
                  value={compareEnd ? toISODate(compareEnd) : ""}
                  onChange={(e) => setCompareEnd(e.target.value ? parseISODate(e.target.value) : null)}
                  className="w-1/2 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
                />
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={applyRange}
                className="flex-1 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
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

export type { DateRange };
