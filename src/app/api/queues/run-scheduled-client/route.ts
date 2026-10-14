import { handleCallback } from "@vercel/queue";
import { runScheduledClient } from "@/lib/scheduled-run";

export const runtime = "nodejs";
export const maxDuration = 800; // Pro plan ceiling -- runs wait on the full Python pipeline call

/**
 * Queue consumer for "llm-pipeline-jobs" -- no public URL, unreachable from
 * the internet by Vercel's design, so no auth check needed here (unlike the
 * cron producer route, which does check CRON_SECRET).
 */
export const POST = handleCallback<{ clientId: string }>(async (message) => {
  await runScheduledClient(message.clientId);
});
