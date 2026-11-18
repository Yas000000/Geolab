-- A benchmark's own #1 Rankings, Top-3 Visibility and Answers Citing Your Site,
-- when its source has them (MacuMira's Updated GEO Benchmarks: 24 answers at #1,
-- 33.3%, and 33.3% of answers citing macumira.com), and its sentiment as a
-- decimal (78.2, not 78). All nullable: existing rows keep working out #1
-- Rankings / Top-3 Visibility from their prompt table and count citing as 0.

-- AlterTable
ALTER TABLE "BenchmarkSnapshot" ADD COLUMN     "ownRank1Count" INTEGER,
ADD COLUMN     "ownSiteCitedPct" DOUBLE PRECISION,
ADD COLUMN     "ownTop3Pct" DOUBLE PRECISION,
ALTER COLUMN "ownSentiment" SET DATA TYPE DOUBLE PRECISION;
