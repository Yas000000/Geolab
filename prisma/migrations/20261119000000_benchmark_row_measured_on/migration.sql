-- A benchmark row can be measured on its own day, when a platform's benchmark
-- comes from a later source than the rest (MacuMira's Claude rows: Oct 19,
-- 2026, from its October report; its other platforms: Jun 1). Null: the
-- snapshot's own date, as every existing row.

-- AlterTable
ALTER TABLE "BenchmarkPromptResult" ADD COLUMN     "measuredOn" TIMESTAMP(3);
