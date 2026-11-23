-- "1st of every month" schedule (src/lib/due-clients.ts). Adds an enum value
-- only; nothing existing changes.

-- AlterEnum
ALTER TYPE "RunSchedule" ADD VALUE 'FIRST_OF_MONTH';
