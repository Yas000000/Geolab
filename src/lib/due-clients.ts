import { RunSchedule } from "@/generated/prisma/client";

const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a client is due for its next automated run, based on its
 * RunSchedule and when its last automated run completed. Pure function --
 * day-count thresholds, not calendar-exact (same pragmatic approach already
 * used by src/lib/date-range.ts elsewhere in this project).
 */
export function isDue(schedule: RunSchedule, lastScheduledRunAt: Date | null, now: Date): boolean {
  if (schedule === "MANUAL") return false;
  if (schedule === "NIGHTLY") return true;
  if (!lastScheduledRunAt) return true;

  const elapsedMs = now.getTime() - lastScheduledRunAt.getTime();
  if (schedule === "WEEKLY") return elapsedMs >= WEEKLY_MS;
  return elapsedMs >= MONTHLY_MS; // MONTHLY
}
