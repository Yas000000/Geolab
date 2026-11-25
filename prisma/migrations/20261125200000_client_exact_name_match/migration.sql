-- "Match the name exactly" per client (Settings / Add Client). New column, off by
-- default; nothing existing changes.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "exactNameMatch" BOOLEAN NOT NULL DEFAULT false;
