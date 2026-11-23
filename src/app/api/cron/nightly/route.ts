import { prisma } from "@/lib/prisma";
import { isDue } from "@/lib/due-clients";
import { clientsDueForCrawlCheck, runCrawlCheck } from "@/lib/crawl-check";
import { send } from "@vercel/queue";
import { SCHEDULED_RUN_SPACING_MINUTES } from "@/lib/schedule-options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // the monthly AI crawler checks run here, in parallel, ~15-60s each

/**
 * Fires once daily (vercel.json). Stays thin per Vercel's own current
 * guidance for cron routes -- no pipeline logic here, just enqueues one
 * job per due client onto the "llm-pipeline-jobs" queue. The actual work
 * happens in src/app/api/queues/run-scheduled-client/route.ts, each
 * invocation getting its own fresh execution-time budget.
 */
export async function GET(request: Request): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const clients = await prisma.client.findMany({
    where: { schedule: { not: "MANUAL" }, archivedAt: null },
    select: { id: true, schedule: true, lastScheduledRunAt: true },
    orderBy: { name: "asc" },
  });

  const now = new Date();
  const due = clients.filter((c) => isDue(c.schedule, c.lastScheduledRunAt, now));

  // One client starts every SCHEDULED_RUN_SPACING_MINUTES, not all at once (2026-11-23):
  // the queue starts every job the moment it's visible, and each run already asks each
  // AI platform 15 questions at a time, pacing only itself. Fifteen clients at once
  // would be ~225 calls per platform, far past Perplexity's ~3 requests a second, and
  // the refused calls become blank answers in that month's data. A Live Search run
  // takes 3-6 minutes, so 10 minutes apart they barely overlap.
  // idempotencyKey: a second cron call the same day (Vercel can deliver one twice)
  // can't queue a second run of the same client.
  const day = now.toISOString().slice(0, 10);
  for (const [i, client] of due.entries()) {
    const delaySeconds = i * SCHEDULED_RUN_SPACING_MINUTES * 60;
    await send(
      "llm-pipeline-jobs",
      { clientId: client.id },
      {
        delaySeconds,
        // A delay can't outlast the message (default 24h), so it's kept a day past its start.
        retentionSeconds: Math.min(7 * 24 * 3600, delaySeconds + 24 * 3600),
        idempotencyKey: `scheduled-run:${client.id}:${day}`,
      },
    );
  }

  // Monthly AI crawler access check, same non-MANUAL gate as the runs above.
  // Short calls (three vendor requests in parallel per client), so they run
  // here directly rather than through the queue.
  const crawlDue = await clientsDueForCrawlCheck(now);
  const crawlResults = await Promise.allSettled(crawlDue.map((id) => runCrawlCheck(id, "cron")));
  const crawlChecked = crawlResults.filter((r) => r.status === "fulfilled" && r.value.ok).length;

  return Response.json({
    checked: clients.length,
    enqueued: due.length,
    spacingMinutes: SCHEDULED_RUN_SPACING_MINUTES,
    crawlDue: crawlDue.length,
    crawlChecked,
  });
}
