-- AI Conversions on the GEO Traffic tab: a per-client Settings switch, and daily key
-- events / engaged sessions from AI traffic. New nullable columns and one boolean with a
-- default only; nothing existing changes.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "showAiConversions" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AiTrafficSnapshot" ADD COLUMN     "aiAssistantEngagedSessions" INTEGER,
ADD COLUMN     "aiAssistantKeyEvents" INTEGER,
ADD COLUMN     "aiIntroducedKeyEvents" INTEGER,
ADD COLUMN     "aiKeyEventsByName" JSONB,
ADD COLUMN     "referralAiEngagedSessions" INTEGER,
ADD COLUMN     "referralAiKeyEvents" INTEGER,
ADD COLUMN     "siteEngagedSessions" INTEGER,
ADD COLUMN     "siteKeyEvents" INTEGER,
ADD COLUMN     "siteSessions" INTEGER,
ADD COLUMN     "unassignedAiEngagedSessions" INTEGER,
ADD COLUMN     "unassignedAiKeyEvents" INTEGER;
