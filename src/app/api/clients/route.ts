import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { importHistoryForClient } from "@/lib/analytics-sync";
import { RunStatus, RunSchedule } from "@/generated/prisma/client";
import { findOrCreateClient, findOrCreateBrand, callPipelineAndPersist } from "@/lib/run-persistence";
import { parsePromptsText, promptKey } from "@/lib/parse-prompts";
import { cleanLocation, pipelineLocations, type LocationInput } from "@/lib/client-locations";
import { requireTeam } from "@/lib/viewer";
import { cleanOtherNames } from "@/lib/client-names";

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
  // Places the client is tracked in, and which of them (indexes into locations)
  // each prompt is tracked in, keyed by promptKey(text). A prompt left out: all of them.
  locations?: LocationInput[];
  promptLocations?: Record<string, number[]>;
  // Names AI answers use for the client besides brandName ("Alaco" for Alaco Ladder).
  otherNames?: string[] | string;
  // Count the names only exactly: same capitals, whole word ("SignUp", not "SignUpGenius").
  exactNameMatch?: boolean;
}

function pipelineUrl(request: Request): string {
  if (process.env.PYTHON_PIPELINE_URL) return process.env.PYTHON_PIPELINE_URL;
  return new URL("/api/run_pipeline", request.url).toString();
}

export async function POST(request: Request): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const body = (await request.json()) as NewClientRequestBody;
  const { brandName, domain, promptsText } = body;

  const parsedPrompts = parsePromptsText(promptsText);
  if (parsedPrompts.length === 0) {
    return Response.json({ error: "No prompts found in the pasted text." }, { status: 400 });
  }
  const cleaned = (body.locations ?? []).map(cleanLocation);
  const bad = cleaned.find((l) => typeof l === "string");
  if (bad) return Response.json({ error: bad }, { status: 400 });
  const locations = cleaned as Exclude<(typeof cleaned)[number], string>[];
  if (new Set(locations.map((l) => l.label.toLowerCase())).size !== locations.length) {
    return Response.json({ error: "Two locations have the same name." }, { status: 400 });
  }
  const otherNames = cleanOtherNames(body.otherNames, brandName);
  if (typeof otherNames === "string") return Response.json({ error: otherNames }, { status: 400 });

  const client = await findOrCreateClient(brandName, domain, {
    schedule: body.schedule ? RunSchedule[body.schedule] : undefined,
    ga4PropertyId: body.ga4PropertyId,
    gscSiteUrl: body.gscSiteUrl,
  });
  // Saved before the first run, which reads them (callPipelineAndPersist). Adding an
  // existing client again keeps the names and matching it has unless new ones were given.
  if (otherNames.length || body.exactNameMatch) {
    await prisma.client.update({
      where: { id: client.id },
      data: { ...(otherNames.length ? { otherNames } : {}), ...(body.exactNameMatch ? { exactNameMatch: true } : {}) },
    });
  }
  const brand = await findOrCreateBrand(client.id, brandName, true);
  // Locations: created once (adding an existing client again keeps the ones it has).
  const locationIds: string[] = [];
  for (const [i, l] of locations.entries()) {
    const row =
      (await prisma.clientLocation.findFirst({ where: { clientId: client.id, label: { equals: l.label, mode: "insensitive" } } })) ??
      (await prisma.clientLocation.create({ data: { clientId: client.id, ...l, position: i + 1 } }));
    locationIds.push(row.id);
  }
  const promptLocationIds = (text: string) =>
    (body.promptLocations?.[promptKey(text)] ?? locations.map((_, i) => i)).map((i) => locationIds[i]).filter(Boolean);
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
      triggeredBy: viewer.email,
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
      // The first check is Training Search, which ignores locations; the prompt list keeps
      // them for Live Search (Run Now's Live Search or scheduled runs).
      prompts: parsedPrompts.map((p) => ({ text: p.text, category: p.category, locationIds: promptLocationIds(p.text) })),
      locations: await pipelineLocations(client.id),
      platforms: body.platforms,
    },
  });

  return Response.json(
    { clientId: client.id, runId: run.id, status: result.status, error: result.error },
    { status: result.status === "COMPLETE" ? 200 : 502 },
  );
}
