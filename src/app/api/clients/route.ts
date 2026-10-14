import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { importHistoryForClient } from "@/lib/analytics-sync";
import { RunStatus, RunSchedule } from "@/generated/prisma/client";
import { findOrCreateClient, findOrCreateBrand, callPipelineAndPersist } from "@/lib/run-persistence";
import { parsePromptsText } from "@/lib/parse-prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // Pro plan ceiling -- runs wait on the full Python pipeline call

interface NewClientRequestBody {
  brandName: string;
  domain: string;
  promptsText: string;
  schedule?: keyof typeof RunSchedule;
  ga4PropertyId?: string;
  gscSiteUrl?: string;
  platforms?: string[];
}

function pipelineUrl(request: Request): string {
  if (process.env.PYTHON_PIPELINE_URL) return process.env.PYTHON_PIPELINE_URL;
  return new URL("/api/run_pipeline", request.url).toString();
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as NewClientRequestBody;
  const { brandName, domain, promptsText } = body;

  const parsedPrompts = parsePromptsText(promptsText);
  if (parsedPrompts.length === 0) {
    return Response.json({ error: "No prompts found in the pasted text." }, { status: 400 });
  }

  const client = await findOrCreateClient(brandName, domain, {
    schedule: body.schedule ? RunSchedule[body.schedule] : undefined,
    ga4PropertyId: body.ga4PropertyId,
    gscSiteUrl: body.gscSiteUrl,
  });
  const brand = await findOrCreateBrand(client.id, brandName, true);
  // Import GA4/Search Console history once the response is sent, so the
  // Traffic page has real history from day one (see /api/clients/[id] PATCH).
  if (client.ga4PropertyId || client.gscSiteUrl) after(importHistoryForClient(client.id));

  const promptSet = await prisma.promptSet.create({
    data: {
      clientId: client.id,
      label: `${brandName} — ${new Date().toISOString()}`,
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
      prompts: parsedPrompts.map((p) => ({ text: p.text, category: p.category })),
      platforms: body.platforms,
    },
  });

  return Response.json(
    { clientId: client.id, runId: run.id, status: result.status, error: result.error },
    { status: result.status === "COMPLETE" ? 200 : 502 },
  );
}
