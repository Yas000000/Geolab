import { RunSchedule } from "@/generated/prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;

// Days by UTC calendar date, not elapsed time. The nightly check runs once a day
// (9:00 UTC, vercel.json) and a run finishes minutes after it starts, so 7 x 24h
// after the last run is always just past the 7th night's check: counted in hours,
// Weekly really ran every 8 days and Monthly every 31 (fixed 2026-11-23).
const utcDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);

// A 1st-of-the-month run that doesn't complete (a pipeline failure, a timeout) is
// tried again each night through this day of the month, then waits for the next 1st.
export const FIRST_OF_MONTH_RETRY_THROUGH_DAY = 7;

/**
 * Whether a client is due for its next automated run, based on its
 * RunSchedule and when its last scheduled run completed (a failed run doesn't
 * count, so it's tried again the next night). Pure function.
 */
export function isDue(schedule: RunSchedule, lastScheduledRunAt: Date | null, now: Date): boolean {
  if (schedule === "MANUAL") return false;
  if (schedule === "NIGHTLY") return true;
  if (schedule === "FIRST_OF_MONTH") {
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const ranThisMonth = !!lastScheduledRunAt && lastScheduledRunAt.getTime() >= monthStart;
    return !ranThisMonth && now.getUTCDate() <= FIRST_OF_MONTH_RETRY_THROUGH_DAY;
  }
  if (!lastScheduledRunAt) return true;

  const days = utcDay(now) - utcDay(lastScheduledRunAt);
  if (schedule === "WEEKLY") return days >= 7;
  return days >= 30; // MONTHLY: every 30 days
}
