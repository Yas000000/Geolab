-- Daily GA4 traffic per country, for the countries of a client's locations
-- (Traffic tab + reports by location). New table only; nothing existing changes.

-- CreateTable
CREATE TABLE "CountryTrafficSnapshot" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "country" TEXT NOT NULL,
    "sessions" INTEGER,
    "activeUsers" INTEGER,
    "keyEvents" INTEGER,
    "directSessions" INTEGER,
    "aiAssistantSessions" INTEGER,
    "referralSessions" INTEGER,
    "referralAiSessions" INTEGER,
    "unassignedSessions" INTEGER,
    "unassignedAiSessions" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CountryTrafficSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CountryTrafficSnapshot_clientId_country_idx" ON "CountryTrafficSnapshot"("clientId", "country");

-- CreateIndex
CREATE UNIQUE INDEX "CountryTrafficSnapshot_clientId_date_country_key" ON "CountryTrafficSnapshot"("clientId", "date", "country");

-- AddForeignKey
ALTER TABLE "CountryTrafficSnapshot" ADD CONSTRAINT "CountryTrafficSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
