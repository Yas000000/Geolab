-- CreateTable
CREATE TABLE "CrawlCheck" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "triggeredBy" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "results" JSONB NOT NULL,

    CONSTRAINT "CrawlCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrawlCheck_clientId_checkedAt_idx" ON "CrawlCheck"("clientId", "checkedAt");

-- AddForeignKey
ALTER TABLE "CrawlCheck" ADD CONSTRAINT "CrawlCheck_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
