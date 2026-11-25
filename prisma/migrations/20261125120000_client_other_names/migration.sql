-- Other names AI answers use for a client (Settings / Add Client), counted as mentions
-- like the brand name. New column with an empty default; nothing existing changes.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "otherNames" TEXT[] DEFAULT ARRAY[]::TEXT[];
