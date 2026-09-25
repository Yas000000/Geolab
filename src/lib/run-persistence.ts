import { prisma } from "@/lib/prisma";
import { Platform, RunStatus } from "@/generated/prisma/client";
import { PLATFORM_MAP, mapSentiment, type PipelineSentiment } from "@/lib/geo-platform-map";

interface PipelinePromptGroup {
  category: string;
  categoryLabel: string;
  prompts: { text: string; score: number | null; reason: string; position: number }[];
}

interface PipelineResultCell {
  promptPosition: number;
  promptText: string;
  category: string;
  platform: string;
  modelId: string;
  responseText: string;
  error: string | null;
  parsed: {
    mentioned: boolean;
    rank: number | null;
    sentiment: PipelineSentiment;
    excerpt: string;
    brandsInResponse: [string, number | null][];
    topItems: [number, string][];
    extractedBrands: string[];
  };
}

interface PipelineResponse {
  promptGroups: PipelinePromptGroup[];
  results: PipelineResultCell[];
  meta: { totalPrompts: number; platformsQueried: string[]; generationWarnings: string[] };
}

export async function findOrCreateClient(
  name: string,
  domain: string,
  extra?: { schedule?: "MANUAL" | "NIGHTLY" | "WEEKLY" | "MONTHLY"; ga4PropertyId?: string; gscSiteUrl?: string },
) {
  const existing = await prisma.client.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (existing) return existing;
  return prisma.client.create({
    data: {
      name,
      domain,
      schedule: extra?.schedule,
      ga4PropertyId: extra?.ga4PropertyId,
      gscSiteUrl: extra?.gscSiteUrl,
    },
  });
}

export async function findOrCreateBrand(clientId: string, name: string, isClientBrand: boolean) {
  const existing = await prisma.brand.findFirst({
    where: { clientId, name: { equals: name, mode: "insensitive" } },
  });
  if (existing) return existing;
  return prisma.brand.create({ data: { clientId, name, isClientBrand } });
}

/**
 * Calls the Python run_pipeline function and persists everything it returns:
 * Prompt rows (from promptGroups), then RawResponse/ParsedResult/Mention
 * rows (from results), then marks the Run COMPLETE or FAILED. Shared by
 * every route that triggers a run (auto-generated services or manually
 * pasted prompts) -- the pipeline's response contract is identical either
 * way, so this function doesn't need to know or care which path produced it.
 */
export async function callPipelineAndPersist(params: {
  runId: string;
  promptSetId: string;
  clientId: string;
  brandId: string;
  brandName: string;
  pipelineUrl: string;
  pipelineBody: object;
}): Promise<{ status: "COMPLETE" | "FAILED"; error?: string }> {
  const { runId, promptSetId, clientId, brandId, brandName, pipelineUrl, pipelineBody } = params;

  let pipeline: PipelineResponse;
  try {
    const res = await fetch(pipelineUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pipelineBody),
    });
    if (!res.ok) {
      throw new Error(`run_pipeline returned ${res.status}: ${await res.text()}`);
    }
    pipeline = (await res.json()) as PipelineResponse;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await prisma.run.update({
      where: { id: runId },
      data: { status: RunStatus.FAILED, completedAt: new Date() },
    });
    return { status: "FAILED", error };
  }

  try {
    // Prompt rows -- created individually (not createMany) so we get back
    // generated ids to link RawResponse.promptId. $transaction's batch form
    // requires each array element to be an un-awaited PrismaPromise (no
    // .then() chained on it), so positions are zipped back in afterward
    // using the same order the create calls were built in.
    const flatPromptSpecs = pipeline.promptGroups.flatMap((group) =>
      group.prompts.map((p) => ({ group, p })),
    );
    const createdPrompts = await prisma.$transaction(
      flatPromptSpecs.map(({ group, p }) =>
        prisma.prompt.create({
          data: {
            promptSetId,
            category: group.category,
            text: p.text,
            position: p.position,
          },
        }),
      ),
    );
    const promptIdByPosition = new Map<number, string>(
      createdPrompts.map((row, i) => [flatPromptSpecs[i].p.position, row.id]),
    );

    // Brand resolution pre-pass: unique extracted names across every result
    // cell, resolved sequentially (outside the big write transaction) so two
    // cells introducing the same new name in one run don't race-create it
    // twice. Exact-name match only for v1 -- BrandAlias/substring merging is
    // a deliberate fast-follow, not ported this pass.
    const brandIdByName = new Map<string, string>();
    brandIdByName.set(brandName.toLowerCase(), brandId);
    const uniqueNames = new Set<string>();
    for (const r of pipeline.results) {
      for (const name of r.parsed.extractedBrands) uniqueNames.add(name);
    }
    for (const name of uniqueNames) {
      const key = name.toLowerCase();
      if (brandIdByName.has(key)) continue;
      const row = await findOrCreateBrand(clientId, name, false);
      brandIdByName.set(key, row.id);
    }

    const writeOps = pipeline.results.map((r) =>
      prisma.rawResponse.create({
        data: {
          runId,
          promptId: promptIdByPosition.get(r.promptPosition)!,
          platform: PLATFORM_MAP[r.platform as keyof typeof PLATFORM_MAP] as Platform,
          modelId: r.modelId,
          responseText: r.responseText,
          parsedResult: {
            create: {
              clientBrandMentioned: r.parsed.mentioned,
              clientBrandRank: r.parsed.rank,
              sentiment: mapSentiment(r.parsed.sentiment),
              excerpt: r.parsed.excerpt || null,
              mentions: {
                create: r.parsed.extractedBrands.map((name, i) => ({
                  brandId: brandIdByName.get(name.toLowerCase()) ?? null,
                  rawLabel: name,
                  position: i + 1,
                  sentiment:
                    name.toLowerCase() === brandName.toLowerCase()
                      ? mapSentiment(r.parsed.sentiment)
                      : null,
                })),
              },
            },
          },
        },
      }),
    );
    await prisma.$transaction(writeOps, { timeout: 30_000 });

    await prisma.run.update({
      where: { id: runId },
      data: { status: RunStatus.COMPLETE, completedAt: new Date() },
    });

    return { status: "COMPLETE" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await prisma.run.update({
      where: { id: runId },
      data: { status: RunStatus.FAILED, completedAt: new Date() },
    });
    return { status: "FAILED", error };
  }
}
