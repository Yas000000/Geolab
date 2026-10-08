-- CreateTable
CREATE TABLE "AiTrafficSnapshot" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "directSessions" INTEGER,
    "aiAssistantSessions" INTEGER,
    "referralSessions" INTEGER,
    "referralAiSessions" INTEGER,
    "unassignedSessions" INTEGER,
    "unassignedAiSessions" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTrafficSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiTrafficSnapshot_clientId_idx" ON "AiTrafficSnapshot"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "AiTrafficSnapshot_clientId_date_key" ON "AiTrafficSnapshot"("clientId", "date");

-- AddForeignKey
ALTER TABLE "AiTrafficSnapshot" ADD CONSTRAINT "AiTrafficSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
