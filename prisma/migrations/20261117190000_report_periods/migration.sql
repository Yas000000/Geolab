-- Reports cover any period of days (not just a calendar month) against a chosen
-- comparison. Existing month reports are backfilled to that month's first and
-- last day, compared with the month before (what they were generated against).

-- AlterTable
ALTER TABLE "MonthlyReport"
ADD COLUMN "compareLabel" TEXT NOT NULL DEFAULT '',
ADD COLUMN "periodEnd" TEXT,
ADD COLUMN "periodStart" TEXT;

-- Backfill
UPDATE "MonthlyReport" SET
  "periodStart" = "month" || '-01',
  "periodEnd" = to_char(to_date("month" || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day', 'YYYY-MM-DD'),
  "compareLabel" = COALESCE("data"->>'previousMonthLabel', '');

ALTER TABLE "MonthlyReport" ALTER COLUMN "periodStart" SET NOT NULL, ALTER COLUMN "periodEnd" SET NOT NULL;

-- DropIndex
DROP INDEX "MonthlyReport_clientId_month_key";

-- AlterTable
ALTER TABLE "MonthlyReport" DROP COLUMN "month";

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyReport_clientId_periodStart_periodEnd_key" ON "MonthlyReport"("clientId", "periodStart", "periodEnd");
