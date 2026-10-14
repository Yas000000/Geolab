import { prisma } from "@/lib/prisma";
import { getGoogleOAuthClient, isAuthError, GOOGLE_CONNECTION_ID } from "@/lib/google-oauth";
import { ROLLING_DAYS, syncClientAnalytics, utcDaysAgo } from "@/lib/analytics-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Daily pull of GA4/GSC metrics for every client with a property configured.
 * Re-pulls the last ROLLING_DAYS days rather than just yesterday: pulling
 * only yesterday left Search Console permanently empty (it publishes data
 * 2-3 days late, so "yesterday" always came back with no rows and was never
 * revisited -- confirmed on Yellowbrick's real data, 2026-10-14).
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

  const startDate = utcDaysAgo(ROLLING_DAYS);
  const endDate = utcDaysAgo(1);
  let pulled = 0;
  let skipped = 0;

  for (const client of clients) {
    try {
      await syncClientAnalytics(oauthClient, client, startDate, endDate);
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
