import { prisma } from "@/lib/prisma";
import { RunStatus } from "@/generated/prisma/client";
import { findOrCreateClient, findOrCreateBrand, callPipelineAndPersist } from "@/lib/run-persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // Pro plan ceiling -- runs wait on the full Python pipeline call

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

  const result = await callPipelineAndPersist({
    runId: run.id,
    promptSetId: promptSet.id,
    clientId: client.id,
    brandId: brand.id,
    brandName,
    pipelineUrl: pipelineUrl(request),
    pipelineBody: {
      domain,
      brand: brandName,
      services,
      audience: body.audience,
      geography: body.geography,
      kickoff_notes: body.kickoffNotes,
      competitors: body.competitors,
      platforms: body.platforms,
    },
  });

  return Response.json(
    { runId: run.id, status: result.status, error: result.error },
    { status: result.status === "COMPLETE" ? 200 : 502 },
  );
}
