import { prisma } from "@/lib/prisma";
import { isDue } from "@/lib/due-clients";
import { clientsDueForCrawlCheck, runCrawlCheck } from "@/lib/crawl-check";
import { send } from "@vercel/queue";

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
    where: { schedule: { not: "MANUAL" } },
    select: { id: true, schedule: true, lastScheduledRunAt: true },
  });

  const now = new Date();
  const due = clients.filter((c) => isDue(c.schedule, c.lastScheduledRunAt, now));

  for (const client of due) {
    await send("llm-pipeline-jobs", { clientId: client.id });
  }

  // Monthly AI crawler access check, same non-MANUAL gate as the runs above.
  // Short calls (three vendor requests in parallel per client), so they run
  // here directly rather than through the queue.
  const crawlDue = await clientsDueForCrawlCheck(now);
  const crawlResults = await Promise.allSettled(crawlDue.map((id) => runCrawlCheck(id, "cron")));
  const crawlChecked = crawlResults.filter((r) => r.status === "fulfilled" && r.value.ok).length;

  return Response.json({ checked: clients.length, enqueued: due.length, crawlDue: crawlDue.length, crawlChecked });
}
