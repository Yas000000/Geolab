-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('RUNNING', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "OutreachPlan" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" "OutreachStatus" NOT NULL DEFAULT 'RUNNING',
    "progress" JSONB,
    "plan" JSONB,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OutreachPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachSite" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "research" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "researchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachSite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutreachPlan_clientId_createdAt_idx" ON "OutreachPlan"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachSite_clientId_domain_key" ON "OutreachSite"("clientId", "domain");

-- AddForeignKey
ALTER TABLE "OutreachPlan" ADD CONSTRAINT "OutreachPlan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachSite" ADD CONSTRAINT "OutreachSite_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
