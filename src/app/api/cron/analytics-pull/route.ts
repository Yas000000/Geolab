import { prisma } from "@/lib/prisma";
import { getGoogleOAuthClient, isAuthError, GOOGLE_CONNECTION_ID } from "@/lib/google-oauth";
import { fetchGa4DailyMetrics, fetchGscDailyMetrics } from "@/lib/google-metrics";
import { fetchAiTrafficBreakdown } from "@/lib/ai-traffic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function yesterday(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Daily pull of GA4/GSC metrics for every client with a property configured.
 * Not gated by Client.schedule (unlike cron/nightly) -- these calls are free
 * and fast, so every configured client gets pulled regardless of its
 * separate GEO-check cadence. No Queues fan-out needed either -- confirmed
 * via research that GA4/GSC quotas and latency comfortably fit a sequential
 * loop over ~15 properties inside this route's own duration budget, unlike
 * the multi-minute LLM pipeline calls that drove the Queues design for
 * cron/nightly.
 */
export async function GET(request: Request): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const oauthClient = await getGoogleOAuthClient();
  if (!oauthClient) {
    return Response.json({ pulled: 0, skipped: 0, reason: "not connected" });
  }

  const clients = await prisma.client.findMany({
    where: { OR: [{ ga4PropertyId: { not: null } }, { gscSiteUrl: { not: null } }] },
    select: { id: true, ga4PropertyId: true, gscSiteUrl: true },
  });

  const date = yesterday();
  let pulled = 0;
  let skipped = 0;

  for (const client of clients) {
    try {
      if (client.ga4PropertyId) {
        const metrics = await fetchGa4DailyMetrics(oauthClient, client.ga4PropertyId, date);
        if (metrics) {
          await prisma.analyticsSnapshot.upsert({
            where: { clientId_date: { clientId: client.id, date } },
            create: { clientId: client.id, date, ...metrics },
            update: metrics,
          });
        }

        const aiTraffic = await fetchAiTrafficBreakdown(oauthClient, client.ga4PropertyId, date);
        if (aiTraffic) {
          await prisma.aiTrafficSnapshot.upsert({
            where: { clientId_date: { clientId: client.id, date } },
            create: { clientId: client.id, date, ...aiTraffic },
            update: aiTraffic,
          });
        }
      }
      if (client.gscSiteUrl) {
        const metrics = await fetchGscDailyMetrics(oauthClient, client.gscSiteUrl, date);
        if (metrics) {
          await prisma.searchConsoleSnapshot.upsert({
            where: { clientId_date: { clientId: client.id, date } },
            create: { clientId: client.id, date, ...metrics },
            update: metrics,
          });
        }
      }
      pulled++;
    } catch (err) {
      if (isAuthError(err)) {
        // Expected Testing-mode failure mode -- the refresh token expired
        // (~weekly) and needs re-authorizing via /settings. No point
        // retrying the same dead token against the remaining clients.
        await prisma.googleOAuthConnection.update({
          where: { id: GOOGLE_CONNECTION_ID },
          data: { lastError: err instanceof Error ? err.message : String(err) },
        });
        console.log(`[analytics-pull] auth error, stopping loop after ${pulled} client(s): ${err instanceof Error ? err.message : err}`);
        return Response.json({ pulled, skipped, stoppedOnAuthError: true });
      }
      console.log(`[analytics-pull] client ${client.id} failed, skipping: ${err instanceof Error ? err.message : err}`);
      skipped++;
    }
  }

  await prisma.googleOAuthConnection.update({
    where: { id: GOOGLE_CONNECTION_ID },
    data: { lastVerifiedAt: new Date(), lastError: null },
  });

  return Response.json({ pulled, skipped });
}
