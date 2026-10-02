import { prisma } from "@/lib/prisma";
import { RunStatus } from "@/generated/prisma/client";
import { callPipelineAndPersist } from "@/lib/run-persistence";

/**
 * No inbound Request is available here (this runs from a queue consumer,
 * not an HTTP route handling a client request), so the pipeline URL can't
 * be derived from request.url the way the two on-demand routes do it.
 * PYTHON_PIPELINE_URL still wins for local dev; production uses
 * VERCEL_PROJECT_PRODUCTION_URL (the stable production domain), NOT
 * VERCEL_URL -- VERCEL_URL resolves to the ephemeral per-deployment alias
 * (e.g. geo-reporting-portal-<hash>-<team>.vercel.app), which Vercel's
 * Deployment Protection walls off behind SSO even for server-to-server
 * calls. Confirmed live: the stable production domain is NOT behind that
 * wall (the cron route itself is reachable there), the per-deployment
 * alias is -- a real 401 "Protected by Vercel Authentication" was hit
 * and traced to this exact distinction before switching variables.
 */
function pipelineUrl(): string {
  if (process.env.PYTHON_PIPELINE_URL) return process.env.PYTHON_PIPELINE_URL;
  return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/run_pipeline`;
}

/**
 * Runs one client's recurring scheduled check, triggered by the Queues
 * consumer (src/app/api/queues/run-scheduled-client/route.ts). Reuses the
 * client's existing tracked prompts rather than regenerating them, and
 * reuses callPipelineAndPersist unchanged -- its own contract already
 * states the pipeline response shape is identical regardless of trigger.
 */
export async function runScheduledClient(clientId: string): Promise<void> {
  const alreadyRunning = await prisma.run.findFirst({
    where: { clientId, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } },
  });
  if (alreadyRunning) {
    console.log(`[scheduled-run] client ${clientId} already has a run in progress, skipping`);
    return;
  }

  const brand = await prisma.brand.findFirst({ where: { clientId, isClientBrand: true } });
  if (!brand) {
    console.log(`[scheduled-run] client ${clientId} has no tracked brand, skipping`);
    return;
  }

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) {
    console.log(`[scheduled-run] client ${clientId} not found, skipping`);
    return;
  }
  if (!client.domain) {
    console.log(`[scheduled-run] client ${clientId} has no domain set, skipping`);
    return;
  }

  // Filtered to PromptSets that actually have prompts, not just the most
  // recent by creation time -- a prior scheduled attempt that failed AFTER
  // creating its own PromptSet but BEFORE the pipeline call persisted any
  // Prompt rows (e.g. a network/auth error) leaves an empty PromptSet
  // behind that would otherwise shadow the real one. Confirmed live: this
  // exact shadowing happened after an earlier failed run in this project.
  const latestPromptSet = await prisma.promptSet.findFirst({
    where: { clientId, prompts: { some: {} } },
    orderBy: { createdAt: "desc" },
    include: { prompts: { orderBy: { position: "asc" } } },
  });
  if (!latestPromptSet || latestPromptSet.prompts.length === 0) {
    console.log(`[scheduled-run] client ${clientId} has no prior prompts to reuse, skipping`);
    return;
  }

  const promptSet = await prisma.promptSet.create({
    data: {
      clientId,
      label: `${client.name} — scheduled ${new Date().toISOString()}`,
    },
  });

  const run = await prisma.run.create({
    data: {
      clientId,
      promptSetId: promptSet.id,
      status: RunStatus.RUNNING,
      triggeredBy: "cron",
    },
  });

  const result = await callPipelineAndPersist({
    runId: run.id,
    promptSetId: promptSet.id,
    clientId,
    brandId: brand.id,
    brandName: brand.name,
    pipelineUrl: pipelineUrl(),
    pipelineBody: {
      domain: client.domain,
      brand: brand.name,
      prompts: latestPromptSet.prompts.map((p) => ({ text: p.text, category: p.category })),
    },
  });

  if (result.status === "COMPLETE") {
    await prisma.client.update({ where: { id: clientId }, data: { lastScheduledRunAt: new Date() } });
  } else {
    console.log(`[scheduled-run] client ${clientId} run ${run.id} failed: ${result.error}`);
  }
}
