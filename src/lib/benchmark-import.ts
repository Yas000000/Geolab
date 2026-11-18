import { prisma } from "@/lib/prisma";

export interface BenchmarkImportCompetitor {
  name: string;
  position?: number | null;
  visibilityPct?: number | null;
  sentiment?: number | null;
  shareOfVoicePct?: number | null;
}

export interface BenchmarkImportPrompt {
  promptText: string;
  position?: number | null;
  sentiment?: number | null;
  visibilityPct?: number | null;
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
          position: p.position ?? null,
          sentiment: p.sentiment ?? null,
          visibilityPct: p.visibilityPct ?? null,
        })),
      },
    },
    include: { competitors: true, prompts: true },
  });
}
