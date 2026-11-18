-- A benchmark's prompt table can have one row per prompt per platform
-- (MacuMira's keyword.com benchmark), so each platform is compared with its
-- own figures; brandsNamed feeds the Rankings tab's "one place below the last
-- brand named" rule. Both nullable: existing rows (Yellowbrick's ISA) stay
-- one combined row per prompt.

-- AlterTable
ALTER TABLE "BenchmarkPromptResult" ADD COLUMN     "brandsNamed" INTEGER,
ADD COLUMN     "platform" "Platform";
