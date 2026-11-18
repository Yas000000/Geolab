-- A saved report covers all of a client's answers (""), one location (its id) or answers
-- searched with no location ("none"); one per period and location. Existing reports: "".

-- DropIndex
DROP INDEX "MonthlyReport_clientId_periodStart_periodEnd_key";

-- AlterTable
ALTER TABLE "MonthlyReport" ADD COLUMN     "location" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyReport_clientId_periodStart_periodEnd_location_key" ON "MonthlyReport"("clientId", "periodStart", "periodEnd", "location");

