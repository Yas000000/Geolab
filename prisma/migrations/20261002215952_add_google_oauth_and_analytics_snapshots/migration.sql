-- CreateTable
CREATE TABLE "GoogleOAuthConnection" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "connectedEmail" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "GoogleOAuthConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "sessions" INTEGER,
    "activeUsers" INTEGER,
    "keyEvents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchConsoleSnapshot" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "clicks" INTEGER,
    "impressions" INTEGER,
    "ctr" DOUBLE PRECISION,
    "avgPosition" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchConsoleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_clientId_idx" ON "AnalyticsSnapshot"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsSnapshot_clientId_date_key" ON "AnalyticsSnapshot"("clientId", "date");

-- CreateIndex
CREATE INDEX "SearchConsoleSnapshot_clientId_idx" ON "SearchConsoleSnapshot"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchConsoleSnapshot_clientId_date_key" ON "SearchConsoleSnapshot"("clientId", "date");

-- AddForeignKey
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchConsoleSnapshot" ADD CONSTRAINT "SearchConsoleSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
