import { prisma } from "@/lib/prisma";
import { Platform, RunStatus } from "@/generated/prisma/client";
import { PLATFORM_MAP, mapSentiment, type PipelineSentiment } from "@/lib/geo-platform-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface RunsRequestBody {
  clientName: string;
  domain: string;
  services: string[];
  brandName?: string;
  audience?: string;
  geography?: string;
  kickoffNotes?: string;
  competitors?: string[];
  platforms?: string[];
}

interface PipelinePromptGroup {
  category: string;
  categoryLabel: string;
  prompts: { text: string; score: number; reason: string; position: number }[];
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

function pipelineUrl(request: Request): string {
  if (process.env.PYTHON_PIPELINE_URL) return process.env.PYTHON_PIPELINE_URL;
  return new URL("/api/run_pipeline", request.url).toString();
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as RunsRequestBody;
  const { clientName, domain, services } = body;
  const brandName = body.brandName ?? clientName;

  const client = await findOrCreateClient(clientName, domain);
  const brand = await findOrCreateBrand(client.id, brandName, true);

  const promptSet = await prisma.promptSet.create({
    data: {
      clientId: client.id,
      label: `${clientName} — ${new Date().toISOString()}`,
    },
  });

  const run = await prisma.run.create({
    data: {
      clientId: client.id,
      promptSetId: promptSet.id,
      status: RunStatus.PENDING,
      triggeredBy: "william@digitalmarketing.com",
    },
  });

  await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.RUNNING } });

  let pipeline: PipelineResponse;
  try {
    const res = await fetch(pipelineUrl(request), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain,
        brand: brandName,
        services,
        audience: body.audience,
        geography: body.geography,
        kickoff_notes: body.kickoffNotes,
        competitors: body.competitors,
        platforms: body.platforms,
      }),
    });
    if (!res.ok) {
      throw new Error(`run_pipeline returned ${res.status}: ${await res.text()}`);
    }
    pipeline = (await res.json()) as PipelineResponse;
  } catch (err) {
    await prisma.run.update({
      where: { id: run.id },
      data: { status: RunStatus.FAILED, completedAt: new Date() },
    });
    return Response.json(
      { runId: run.id, status: "FAILED", error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
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
            promptSetId: promptSet.id,
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
    brandIdByName.set(brandName.toLowerCase(), brand.id);
    const uniqueNames = new Set<string>();
    for (const r of pipeline.results) {
      for (const name of r.parsed.extractedBrands) uniqueNames.add(name);
    }
    for (const name of uniqueNames) {
      const key = name.toLowerCase();
      if (brandIdByName.has(key)) continue;
      const row = await findOrCreateBrand(client.id, name, false);
      brandIdByName.set(key, row.id);
    }

    const writeOps = pipeline.results.map((r) =>
      prisma.rawResponse.create({
        data: {
          runId: run.id,
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
      where: { id: run.id },
      data: { status: RunStatus.COMPLETE, completedAt: new Date() },
    });

    return Response.json({ runId: run.id, status: "COMPLETE" });
  } catch (err) {
    await prisma.run.update({
      where: { id: run.id },
      data: { status: RunStatus.FAILED, completedAt: new Date() },
    });
    return Response.json(
      { runId: run.id, status: "FAILED", error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

async function findOrCreateClient(name: string, domain: string) {
  const existing = await prisma.client.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (existing) return existing;
  return prisma.client.create({ data: { name, domain } });
}

async function findOrCreateBrand(clientId: string, name: string, isClientBrand: boolean) {
  const existing = await prisma.brand.findFirst({
    where: { clientId, name: { equals: name, mode: "insensitive" } },
  });
  if (existing) return existing;
  return prisma.brand.create({ data: { clientId, name, isClientBrand } });
}
