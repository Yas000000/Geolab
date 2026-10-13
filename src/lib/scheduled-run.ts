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

export type RunReusingPromptsResult =
  | { ok: true; runId: string; status: "COMPLETE" }
  | { ok: false; reason: "already_running" | "no_brand" | "client_not_found" | "no_domain" | "no_prompts" }
  | { ok: false; reason: "pipeline_failed"; runId: string; error?: string };

/**
 * Shared core for both the recurring scheduled check and an on-demand
 * "Run Now" trigger (src/app/api/clients/[id]/run/route.ts) -- reuses the
 * client's existing tracked prompts rather than regenerating them, and
 * reuses callPipelineAndPersist unchanged -- its own contract already
 * states the pipeline response shape is identical regardless of trigger.
 * Returns a real result instead of just logging, so an on-demand caller
 * (a button a person is waiting on) can show why it didn't run, not just
 * silently do nothing the way the cron path's log-and-return is fine with.
 */
// Comfortably above this route's own maxDuration (300s) and the queue
// consumer's -- a RUNNING/PENDING row older than this was, in practice,
// killed by the platform's own timeout without ever reaching its own
// catch block (confirmed live: a real Live Search run on 55 prompts hit
// this exact scenario, 2026-10-12, left stuck at RUNNING with 0 persisted
// responses, requiring a manual DB fix to unblock future runs). Self-heal
// instead of requiring that every time.
const STALE_RUN_MS = 10 * 60 * 1000;

async function runClientReusingPrompts(
  clientId: string,
  triggeredBy: string,
  liveSearch: boolean,
): Promise<RunReusingPromptsResult> {
  const inProgress = await prisma.run.findFirst({
    where: { clientId, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } },
  });
  if (inProgress) {
    const age = Date.now() - inProgress.startedAt.getTime();
    if (age < STALE_RUN_MS) return { ok: false, reason: "already_running" };
    // Stale -- almost certainly orphaned by a platform-level timeout, not a
    // real in-flight run. Mark it FAILED so it stops blocking, then proceed.
    await prisma.run.update({
      where: { id: inProgress.id },
      data: { status: RunStatus.FAILED, completedAt: new Date() },
    });
  }

  const brand = await prisma.brand.findFirst({ where: { clientId, isClientBrand: true } });
  if (!brand) return { ok: false, reason: "no_brand" };

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return { ok: false, reason: "client_not_found" };
  if (!client.domain) return { ok: false, reason: "no_domain" };

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
  if (!latestPromptSet || latestPromptSet.prompts.length === 0) return { ok: false, reason: "no_prompts" };

  const promptSet = await prisma.promptSet.create({
    data: {
      clientId,
      label: `${client.name} — ${triggeredBy === "cron" ? "scheduled" : "manual"}${liveSearch ? " (live search)" : ""} ${new Date().toISOString()}`,
    },
  });

  const run = await prisma.run.create({
    data: {
      clientId,
      promptSetId: promptSet.id,
      status: RunStatus.RUNNING,
      triggeredBy,
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
      live_search: liveSearch,
    },
  });

  if (result.status === "COMPLETE") return { ok: true, runId: run.id, status: "COMPLETE" };
  return { ok: false, reason: "pipeline_failed", runId: run.id, error: result.error };
}

/**
 * Runs one client's recurring scheduled check, triggered by the Queues
 * consumer (src/app/api/queues/run-scheduled-client/route.ts).
 */
export async function runScheduledClient(clientId: string): Promise<void> {
  const result = await runClientReusingPrompts(clientId, "cron", false);
  if (result.ok) {
    await prisma.client.update({ where: { id: clientId }, data: { lastScheduledRunAt: new Date() } });
  } else {
    console.log(`[scheduled-run] client ${clientId} did not run: ${result.reason}`);
  }
}

/**
 * On-demand equivalent for the Settings page's "Run Now" button -- same
 * prompt-reuse logic as the scheduled path, but never touches
 * lastScheduledRunAt (that field tracks recurring-cadence due-ness
 * independent of ad hoc activity, see its own doc comment on Client).
 */
export async function runClientNow(
  clientId: string,
  triggeredBy: string,
  liveSearch: boolean,
): Promise<RunReusingPromptsResult> {
  return runClientReusingPrompts(clientId, triggeredBy, liveSearch);
}
