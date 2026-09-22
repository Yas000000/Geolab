-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('CLAUDE', 'CHATGPT', 'GEMINI', 'PERPLEXITY');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "isClientBrand" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandAlias" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,

    CONSTRAINT "BrandAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptSet" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prompt" (
    "id" TEXT NOT NULL,
    "promptSetId" TEXT NOT NULL,
    "category" TEXT,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "Prompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "promptSetId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "triggeredBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawResponse" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "modelId" TEXT,
    "responseText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParsedResult" (
    "id" TEXT NOT NULL,
    "rawResponseId" TEXT NOT NULL,
    "clientBrandMentioned" BOOLEAN NOT NULL,
    "clientBrandRank" INTEGER,
    "sentiment" "Sentiment",
    "excerpt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParsedResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mention" (
    "id" TEXT NOT NULL,
    "parsedResultId" TEXT NOT NULL,
    "brandId" TEXT,
    "rawLabel" TEXT NOT NULL,
    "position" INTEGER,
    "sentiment" "Sentiment",

    CONSTRAINT "Mention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Brand_clientId_idx" ON "Brand"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_clientId_name_key" ON "Brand"("clientId", "name");

-- CreateIndex
CREATE INDEX "BrandAlias_alias_idx" ON "BrandAlias"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "BrandAlias_brandId_alias_key" ON "BrandAlias"("brandId", "alias");

-- CreateIndex
CREATE INDEX "PromptSet_clientId_idx" ON "PromptSet"("clientId");

-- CreateIndex
CREATE INDEX "Prompt_promptSetId_idx" ON "Prompt"("promptSetId");

-- CreateIndex
CREATE INDEX "Run_clientId_idx" ON "Run"("clientId");

-- CreateIndex
CREATE INDEX "Run_promptSetId_idx" ON "Run"("promptSetId");

-- CreateIndex
CREATE INDEX "RawResponse_runId_idx" ON "RawResponse"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "RawResponse_runId_promptId_platform_key" ON "RawResponse"("runId", "promptId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "ParsedResult_rawResponseId_key" ON "ParsedResult"("rawResponseId");

-- CreateIndex
CREATE INDEX "Mention_parsedResultId_idx" ON "Mention"("parsedResultId");

-- CreateIndex
CREATE INDEX "Mention_brandId_idx" ON "Mention"("brandId");

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandAlias" ADD CONSTRAINT "BrandAlias_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptSet" ADD CONSTRAINT "PromptSet_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prompt" ADD CONSTRAINT "Prompt_promptSetId_fkey" FOREIGN KEY ("promptSetId") REFERENCES "PromptSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_promptSetId_fkey" FOREIGN KEY ("promptSetId") REFERENCES "PromptSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawResponse" ADD CONSTRAINT "RawResponse_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawResponse" ADD CONSTRAINT "RawResponse_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "Prompt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParsedResult" ADD CONSTRAINT "ParsedResult_rawResponseId_fkey" FOREIGN KEY ("rawResponseId") REFERENCES "RawResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mention" ADD CONSTRAINT "Mention_parsedResultId_fkey" FOREIGN KEY ("parsedResultId") REFERENCES "ParsedResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mention" ADD CONSTRAINT "Mention_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;
