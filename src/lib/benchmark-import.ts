import { prisma } from "@/lib/prisma";
import type { Platform } from "@/generated/prisma/client";

export interface BenchmarkImportCompetitor {
  name: string;
  position?: number | null;
  visibilityPct?: number | null;
  sentiment?: number | null;
  shareOfVoicePct?: number | null;
}

export interface BenchmarkImportPrompt {
  promptText: string;
  // One row per prompt per platform when the source has them; omit for one combined row per prompt.
  platform?: Platform | null;
  position?: number | null;
  sentiment?: number | null;
  visibilityPct?: number | null;
  brandsNamed?: number | null; // other brands that answer named (per-platform rows)
  measuredOn?: string | null; // ISO date, when not the snapshot's own date
}

export interface BenchmarkImportPayload {
  source: string;
  snapshotDate: string; // ISO date
  ownVisibilityPct?: number | null;
  ownPosition?: number | null;
  ownSentiment?: number | null;
  ownRank1Count?: number | null; // only when the source states it (see BenchmarkSnapshot)
  ownTop3Pct?: number | null; // only when the source states it
  ownSiteCitedPct?: number | null; // only when the source has the data
  sourceNote?: string | null;
  competitors?: BenchmarkImportCompetitor[];
  prompts?: BenchmarkImportPrompt[];
}

export async function importBenchmarkSnapshot(clientId: string, data: BenchmarkImportPayload) {
  return prisma.benchmarkSnapshot.create({
    data: {
      clientId,
      source: data.source,
      snapshotDate: new Date(data.snapshotDate),
      ownVisibilityPct: data.ownVisibilityPct ?? null,
      ownPosition: data.ownPosition ?? null,
      ownSentiment: data.ownSentiment ?? null,
      ownRank1Count: data.ownRank1Count ?? null,
      ownTop3Pct: data.ownTop3Pct ?? null,
      ownSiteCitedPct: data.ownSiteCitedPct ?? null,
      sourceNote: data.sourceNote ?? null,
      competitors: {
        create: (data.competitors ?? []).map((c) => ({
          name: c.name,
          position: c.position ?? null,
          visibilityPct: c.visibilityPct ?? null,
          sentiment: c.sentiment ?? null,
          shareOfVoicePct: c.shareOfVoicePct ?? null,
        })),
      },
      prompts: {
        create: (data.prompts ?? []).map((p) => ({
          promptText: p.promptText,
          platform: p.platform ?? null,
          position: p.position ?? null,
          sentiment: p.sentiment ?? null,
          visibilityPct: p.visibilityPct ?? null,
          brandsNamed: p.brandsNamed ?? null,
          measuredOn: p.measuredOn ? new Date(p.measuredOn) : null,
        })),
      },
    },
    include: { competitors: true, prompts: true },
  });
}
