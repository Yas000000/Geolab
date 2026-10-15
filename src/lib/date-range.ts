export interface DateRange {
  start: Date;
  end: Date;
}

export type CompareMode = "none" | "lastPeriod" | "lastYear" | "custom";

export type PresetKey =
  | "today"
  | "yesterday"
  | "allTime"
  | "custom"
  | "last7"
  | "last30"
  | "lastNDays"
  | "lastWeek"
  | "lastMonth"
  | "lastNMonths"
  | "thisMonth"
  | "thisQuarter"
  | "lastQuarter"
  | "thisYear"
  | "lastYear";

// Static preset rows in display order. lastNDays/lastNMonths are rendered
// specially by the picker (with an inline editable number) but still listed
// here so their position in the list is defined in one place.
export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "allTime", label: "All Time" },
  { key: "custom", label: "Custom" },
  { key: "last7", label: "Last 7 Days" },
  { key: "last30", label: "Last 30 Days" },
  { key: "lastNDays", label: "Last {n} Days" },
  { key: "lastWeek", label: "Last Week" },
  { key: "lastMonth", label: "Last Month" },
  { key: "lastNMonths", label: "Last {n} Months" },
  { key: "thisMonth", label: "This Month" },
  { key: "thisQuarter", label: "This Quarter" },
  { key: "lastQuarter", label: "Last Quarter" },
  { key: "thisYear", label: "This Year" },
  { key: "lastYear", label: "Last Year" },
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}
function addYears(d: Date, n: number): Date {
  const x = new Date(d);
  x.setFullYear(x.getFullYear() + n);
  return x;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function startOfQuarter(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
}
function endOfQuarter(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3 + 3, 0);
}
function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}
function endOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 11, 31);
}
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() - x.getDay()); // Sunday-start, matches the calendar grid
  return x;
}

/** Resolves a preset key (using the given "today") into a concrete date range. allTime/custom resolve to null -- callers handle those separately. */
export function resolvePreset(
  key: PresetKey,
  opts: { nDays: number; nMonths: number },
  today: Date = new Date(),
): DateRange | null {
  const t = startOfDay(today);
  switch (key) {
    case "today":
      return { start: t, end: t };
    case "yesterday": {
      const y = addDays(t, -1);
      return { start: y, end: y };
    }
    case "allTime":
    case "custom":
      return null;
    case "last7":
      return { start: addDays(t, -6), end: t };
    case "last30":
      return { start: addDays(t, -29), end: t };
    case "lastNDays":
      return { start: addDays(t, -(opts.nDays - 1)), end: t };
    case "lastWeek": {
      const end = addDays(startOfWeek(t), -1);
      return { start: addDays(end, -6), end };
    }
    case "lastMonth": {
      const anchor = addMonths(t, -1);
      return { start: startOfMonth(anchor), end: endOfMonth(anchor) };
    }
    case "lastNMonths":
      return { start: addMonths(t, -opts.nMonths), end: t };
    case "thisMonth":
      return { start: startOfMonth(t), end: t };
    case "thisQuarter":
      return { start: startOfQuarter(t), end: t };
    case "lastQuarter": {
      const anchor = addMonths(t, -3);
      return { start: startOfQuarter(anchor), end: endOfQuarter(anchor) };
    }
    case "thisYear":
      return { start: startOfYear(t), end: t };
    case "lastYear": {
      const anchor = addYears(t, -1);
      return { start: startOfYear(anchor), end: endOfYear(anchor) };
    }
  }
}

/** Derives the comparison window from an already-resolved primary range. "lastPeriod"/"lastYear" are meaningless without a concrete primary range (All Time has no natural "period before it"), so they resolve to null in that case rather than guessing. */
export function resolveComparisonRange(
  primary: DateRange | null,
  mode: CompareMode,
  custom?: DateRange | null,
): DateRange | null {
  if (mode === "none") return null;
  if (mode === "custom") return custom ?? null;
  if (!primary) return null;
  if (mode === "lastYear") {
    return { start: addYears(primary.start, -1), end: addYears(primary.end, -1) };
  }
  // lastPeriod: the immediately preceding period of equal length.
  const lengthMs = primary.end.getTime() - primary.start.getTime();
  const end = addDays(primary.start, -1);
  const start = new Date(end.getTime() - lengthMs);
  return { start, end };
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// `utc`: pin formatting to UTC for a Date whose calendar day was already
// fixed server-side (e.g. a prop computed once in a Server Component, like
// the picker's allTimeRange) -- without this, SSR (Vercel runs in UTC) and
// client hydration (the browser's real local timezone) can format the same
// underlying instant as different calendar days, which React detects as a
// hydration mismatch (error #418), not just a cosmetic off-by-one. Leave
// false (the default) for a Date built via parseISODate() from a URL param --
// those are self-consistently "local" on both the server and the client
// since both sides construct AND format in their own local terms, so no pin
// is needed or correct there.
export function formatDisplayDate(d: Date, utc = false): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: utc ? "UTC" : undefined });
}

/**
 * The "All Time" span for a client: from its first GEO data point -- its
 * earliest complete run or imported benchmark, whichever is earlier -- to
 * now. Shared by the Rankings and Traffic pages so "All Time" means the
 * same period on both (Traffic's GA4 history can reach back years before
 * GEO tracking started; it stays reachable via a custom range).
 *
 * run.startedAt is a real moment-in-time (truncate in LOCAL terms, matching
 * the pages' local-day window convention); benchmark snapshotDate is a
 * UTC-midnight date-only value (truncate in UTC terms) -- mixing these
 * without normalizing first reintroduces this project's recurring
 * off-by-one-day bug.
 */
export function geoAllTimeRange(runStarts: Date[], benchmarkDates: Date[]): DateRange | null {
  const localCalendarDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const utcCalendarDay = (d: Date) => new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
  const starts = [...runStarts.map(localCalendarDay), ...benchmarkDates.map(utcCalendarDay)];
  return starts.length ? { start: new Date(Math.min(...starts)), end: new Date() } : null;
}
