-- CreateTable
CREATE TABLE "BenchmarkSnapshot" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "snapshotDate" TIMESTAMP(3) NOT NULL,
    "ownVisibilityPct" DOUBLE PRECISION,
    "ownPosition" DOUBLE PRECISION,
    "ownSentiment" INTEGER,
    "sourceNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BenchmarkSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkCompetitor" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" DOUBLE PRECISION,
    "visibilityPct" DOUBLE PRECISION,
    "sentiment" INTEGER,
    "shareOfVoicePct" DOUBLE PRECISION,

    CONSTRAINT "BenchmarkCompetitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkPromptResult" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "promptText" TEXT NOT NULL,
    "position" DOUBLE PRECISION,
    "sentiment" INTEGER,
    "visibilityPct" DOUBLE PRECISION,

    CONSTRAINT "BenchmarkPromptResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BenchmarkSnapshot_clientId_idx" ON "BenchmarkSnapshot"("clientId");

-- CreateIndex
CREATE INDEX "BenchmarkCompetitor_snapshotId_idx" ON "BenchmarkCompetitor"("snapshotId");

-- CreateIndex
CREATE INDEX "BenchmarkPromptResult_snapshotId_idx" ON "BenchmarkPromptResult"("snapshotId");

-- AddForeignKey
ALTER TABLE "BenchmarkSnapshot" ADD CONSTRAINT "BenchmarkSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkCompetitor" ADD CONSTRAINT "BenchmarkCompetitor_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BenchmarkSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkPromptResult" ADD CONSTRAINT "BenchmarkPromptResult_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BenchmarkSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
