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

/**
 * Saves a new tracked prompt list (text, category and the locations each is
 * tracked in) as a run-less PromptSet: the current set's Prompt rows belong to
 * past runs' answers, so they're never edited in place.
 */
export async function saveTrackedPrompts(
  clientId: string,
  label: string,
  prompts: { category: string | null; text: string; locationIds: string[] }[],
) {
  return prisma.promptSet.create({
    data: {
      clientId,
      label,
      prompts: {
        create: prompts.map((p, i) => ({ category: p.category, text: p.text, position: i + 1, locationIds: p.locationIds })),
      },
    },
  });
}

/** Same prompts, categories, order and locations. */
export function samePromptList(
  a: { category: string | null; text: string; locationIds?: string[] | null }[],
  b: { category: string | null; text: string; locationIds?: string[] | null }[],
): boolean {
  const ids = (x: { locationIds?: string[] | null }) => [...(x.locationIds ?? [])].sort().join(",");
  return a.length === b.length && a.every((p, i) => p.text === b[i].text && p.category === b[i].category && ids(p) === ids(b[i]));
}
