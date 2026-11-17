// Report periods: inclusive runs of UTC calendar days as "YYYY-MM-DD" strings.
// Pure (no Prisma), so the Reports form and the server label periods the same
// way: every Date here is UTC midnight and formatted with timeZone UTC, so
// SSR and the browser can't disagree about the day.

export interface ReportPeriod {
  start: string; // first day, "YYYY-MM-DD"
  end: string; // last day (inclusive)
  label: string; // "October 2026", or "Oct 5 – Nov 4, 2026"
}

/** What a report compares against. */
export type CompareSpec =
  | { kind: "benchmark"; snapshotId: string } // an imported benchmark (e.g. the ISA)
  | { kind: "firstCrawl" } // the client's first training run and first live search run
  | { kind: "previous" } // the equal-length period just before (a whole month: the month before)
  | { kind: "custom"; start: string; end: string };

export const MAX_PERIOD_DAYS = 366;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDay(s: unknown): s is string {
  if (typeof s !== "string" || !DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const dayDate = (s: string) => new Date(`${s}T00:00:00Z`);
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  const d = dayDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

export function periodDays(start: string, end: string): number {
  return Math.round((dayDate(end).getTime() - dayDate(start).getTime()) / 86_400_000) + 1;
}

/** [start, end) instants covering the period's days. */
export function periodBounds(p: { start: string; end: string }): { start: Date; end: Date } {
  return { start: dayDate(p.start), end: dayDate(addDays(p.end, 1)) };
}

function monthStart(month: string) {
  return `${month}-01`;
}
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const monthEnd = (month: string) => addDays(monthStart(shiftMonth(month, 1)), -1);

/** "YYYY-MM" when the days are exactly one calendar month, else null. */
export function wholeMonth(start: string, end: string): string | null {
  if (!start.endsWith("-01")) return null;
  const month = start.slice(0, 7);
  return monthEnd(month) === end ? month : null;
}

const fmtDay = (day: string, withYear: boolean) =>
  dayDate(day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: withYear ? "numeric" : undefined, timeZone: "UTC" });

/** "October 2026" for a whole month, else "Oct 5 – Nov 4, 2026" (year on both ends only when they differ). */
export function periodLabel(start: string, end: string): string {
  const month = wholeMonth(start, end);
  if (month) return dayDate(monthStart(month)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  if (start === end) return fmtDay(start, true);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${fmtDay(start, !sameYear)} – ${fmtDay(end, true)}`;
}

/** "Oct 12, 2026" or "Oct 12 – 13, 2026" style label for a set of days (used for benchmark dates). */
export function daysLabel(days: string[]): string {
  const sorted = [...new Set(days)].sort();
  if (!sorted.length) return "";
  return periodLabel(sorted[0], sorted[sorted.length - 1]);
}

export function makePeriod(start: string, end: string): ReportPeriod {
  return { start, end, label: periodLabel(start, end) };
}

export function monthPeriod(month: string): ReportPeriod {
  return makePeriod(monthStart(month), monthEnd(month));
}

const thisMonth = (now: Date) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

/** The most recent full calendar month (UTC): the default report period. */
export function lastFullMonth(now = new Date()): ReportPeriod {
  return monthPeriod(shiftMonth(thisMonth(now), -1));
}

/** The equal-length period just before; for a whole month, the month before. */
export function previousPeriod(start: string, end: string): ReportPeriod {
  const month = wholeMonth(start, end);
  if (month) return monthPeriod(shiftMonth(month, -1));
  const newEnd = addDays(start, -1);
  return makePeriod(addDays(newEnd, -(periodDays(start, end) - 1)), newEnd);
}

/** The same number of days as the report period, ending on (and including) `day`. */
export function periodEndingOn(day: string, lengthDays: number): ReportPeriod {
  return makePeriod(addDays(day, -(lengthDays - 1)), day);
}

/** Quick picks for the report period, resolved against `now` (UTC). */
export function periodPresets(now = new Date()): { key: string; label: string; period: ReportPeriod }[] {
  const today = isoDay(now);
  const cur = thisMonth(now);
  return [
    { key: "lastMonth", label: "Last full month", period: lastFullMonth(now) },
    { key: "thisMonth", label: "This month so far", period: makePeriod(monthStart(cur), today) },
    { key: "last30", label: "Last 30 days", period: periodEndingOn(today, 30) },
    { key: "last3Months", label: "Last 3 full months", period: makePeriod(monthStart(shiftMonth(cur, -3)), monthEnd(shiftMonth(cur, -1))) },
  ];
}

/** Validates a period's days. Returns an error message, or null when fine. */
export function periodError(start: unknown, end: unknown, what = "report period"): string | null {
  if (!isValidDay(start) || !isValidDay(end)) return `Pick a start and end day for the ${what}.`;
  if (start > end) return `The ${what} ends before it starts.`;
  if (periodDays(start, end) > MAX_PERIOD_DAYS) return `Pick a ${what} of a year or less.`;
  return null;
}

/** Parses a request body's compare value. */
export function parseCompareSpec(raw: unknown): CompareSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "benchmark" && typeof r.snapshotId === "string" && r.snapshotId) return { kind: "benchmark", snapshotId: r.snapshotId };
  if (r.kind === "firstCrawl" || r.kind === "previous") return { kind: r.kind };
  if (r.kind === "custom" && isValidDay(r.start) && isValidDay(r.end)) return { kind: "custom", start: r.start, end: r.end };
  return null;
}
