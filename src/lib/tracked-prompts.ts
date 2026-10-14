import { prisma } from "@/lib/prisma";

/**
 * The prompt list a client's next run will use: the most recent PromptSet
 * that actually has prompts. Shared by the run path (scheduled-run.ts) and
 * the Settings page's Tracked Prompts editor, so what the editor shows is
 * exactly what the next Run Now / scheduled run sends to the pipeline.
 *
 * Filtered to non-empty sets, not just the most recent by creation time --
 * a run that failed AFTER creating its own PromptSet but BEFORE the
 * pipeline call persisted any Prompt rows (e.g. a network/auth error)
 * leaves an empty PromptSet behind that would otherwise shadow the real
 * one. Confirmed live: this exact shadowing happened after an earlier
 * failed run in this project.
 *
 * A PromptSet saved from the editor has no Run attached -- it exists only
 * to become "the latest non-empty set" for the next run to copy from.
 */
export async function getTrackedPromptSet(clientId: string) {
  return prisma.promptSet.findFirst({
    where: { clientId, prompts: { some: {} } },
    orderBy: { createdAt: "desc" },
    include: { prompts: { orderBy: { position: "asc" } } },
  });
}
