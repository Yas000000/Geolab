// The Schedule dropdown's choices (client Settings and New Client), in order.
// Values are the RunSchedule enum (prisma/schema.prisma); src/lib/due-clients.ts
// decides when each is due. "Monthly" became "Every 30 days" when the calendar
// option arrived (2026-11-23), so the two can't be confused.
export const SCHEDULE_OPTIONS = [
  { value: "MANUAL", label: "Manual" },
  { value: "NIGHTLY", label: "Nightly" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Every 30 days" },
  { value: "FIRST_OF_MONTH", label: "1st of every month" },
] as const;

export type ScheduleValue = (typeof SCHEDULE_OPTIONS)[number]["value"];

// Minutes between the starts of clients due the same night (src/app/api/cron/nightly/route.ts).
export const SCHEDULED_RUN_SPACING_MINUTES = 10;

export const SCHEDULE_NOTE =
  `Scheduled runs start after 9:00 UTC. When several clients are due the same night, ` +
  `they start ${SCHEDULED_RUN_SPACING_MINUTES} minutes apart so the AI platforms aren't asked everything at once.`;
