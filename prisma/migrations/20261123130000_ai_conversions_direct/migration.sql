-- AI Conversions: Direct's own daily key events, engaged sessions and first-visit key
-- events, for the Direct AI estimate. New nullable columns only; nothing existing changes.

-- AlterTable
ALTER TABLE "AiTrafficSnapshot" ADD COLUMN     "directEngagedSessions" INTEGER,
ADD COLUMN     "directIntroducedKeyEvents" INTEGER,
ADD COLUMN     "directKeyEvents" INTEGER;
