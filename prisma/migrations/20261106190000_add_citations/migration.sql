-- CreateTable
CREATE TABLE "Citation" (
    "id" TEXT NOT NULL,
    "rawResponseId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "domain" TEXT NOT NULL,

    CONSTRAINT "Citation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Citation_rawResponseId_idx" ON "Citation"("rawResponseId");

-- CreateIndex
CREATE INDEX "Citation_domain_idx" ON "Citation"("domain");

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_rawResponseId_fkey" FOREIGN KEY ("rawResponseId") REFERENCES "RawResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
