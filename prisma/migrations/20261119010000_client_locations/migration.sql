-- Locations a client is tracked in (MacuMira: Canada, Australia, New Zealand). Live
-- Search asks each prompt once per location in Prompt.locationIds and records each
-- answer's location (RawResponse.locationId). Existing rows: no locations, unchanged.
-- The one-answer-per-run/prompt/platform key gains the location.

-- DropIndex
DROP INDEX "RawResponse_runId_promptId_platform_key";

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "scheduledLiveSearch" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Prompt" ADD COLUMN     "locationIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "RawResponse" ADD COLUMN     "locationId" TEXT;

-- CreateTable
CREATE TABLE "ClientLocation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "region" TEXT,
    "city" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientLocation_clientId_idx" ON "ClientLocation"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientLocation_clientId_label_key" ON "ClientLocation"("clientId", "label");

-- CreateIndex
CREATE INDEX "RawResponse_locationId_idx" ON "RawResponse"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "RawResponse_runId_promptId_platform_locationId_key" ON "RawResponse"("runId", "promptId", "platform", "locationId");

-- AddForeignKey
ALTER TABLE "ClientLocation" ADD CONSTRAINT "ClientLocation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawResponse" ADD CONSTRAINT "RawResponse_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ClientLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

