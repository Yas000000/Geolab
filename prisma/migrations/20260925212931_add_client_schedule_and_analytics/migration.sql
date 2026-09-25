-- CreateEnum
CREATE TYPE "RunSchedule" AS ENUM ('MANUAL', 'NIGHTLY', 'WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "ga4PropertyId" TEXT,
ADD COLUMN     "gscSiteUrl" TEXT,
ADD COLUMN     "schedule" "RunSchedule" NOT NULL DEFAULT 'MANUAL';
