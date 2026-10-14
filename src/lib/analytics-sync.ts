import type { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { fetchGa4DailySeries, fetchGscDailySeries } from "@/lib/google-metrics";
import { fetchAiTrafficDailySeries } from "@/lib/ai-traffic";
import { getGoogleOAuthClient, isAuthError, GOOGLE_CONNECTION_ID } from "@/lib/google-oauth";

// Search Console's own retention limit (~16 months) -- also covers the
// date picker's "Last Year" comparison. GA4 keeps longer, but importing the
// same span for both keeps the Traffic page's sources aligned.
export const HISTORY_DAYS = 486;

// The daily pull re-fetches this many days, not just yesterday: Search
// Console only returns finalized data (2-3 days behind), and GA4 keeps
// revising the most recent day or two. Upserts make re-pulls idempotent.
export const ROLLING_DAYS = 7;

/** UTC midnight `n` days before today -- the snapshot tables' date convention. */
export function utcDaysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function dayToDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

async function upsertInBatches<T>(ops: Prisma.PrismaPromise<T>[]) {
  for (let i = 0; i < ops.length; i += 200) {
    await prisma.$transaction(ops.slice(i, i + 200));
  }
}

export interface AnalyticsSyncResult {
  ga4Days: number;
  aiDays: number;
  gscDays: number;
}

/**
 * Pulls a client's GA4, AI-traffic and Search Console data for every day in
 * [startDate, endDate] and upserts one snapshot row per day per source.
 * Used by both the daily cron (rolling window) and the history import
 * (16 months). Throws on any Google API error -- callers decide whether an
 * auth error stops a whole loop (the cron) or just reports back (import).
 */
export async function syncClientAnalytics(
  oauthClient: OAuth2Client,
  client: { id: string; ga4PropertyId: string | null; gscSiteUrl: string | null },
  startDate: Date,
  endDate: Date,
): Promise<AnalyticsSyncResult> {
  const result: AnalyticsSyncResult = { ga4Days: 0, aiDays: 0, gscDays: 0 };
  const clientId = client.id;

  if (client.ga4PropertyId) {
    const ga4 = await fetchGa4DailySeries(oauthClient, client.ga4PropertyId, startDate, endDate);
    await upsertInBatches(
      [...ga4].map(([key, metrics]) => {
        const date = dayToDate(key);
        return prisma.analyticsSnapshot.upsert({
          where: { clientId_date: { clientId, date } },
          create: { clientId, date, ...metrics },
          update: metrics,
        });
      }),
    );
    result.ga4Days = ga4.size;

    const ai = await fetchAiTrafficDailySeries(oauthClient, client.ga4PropertyId, startDate, endDate);
    await upsertInBatches(
      [...ai].map(([key, breakdown]) => {
        const date = dayToDate(key);
        return prisma.aiTrafficSnapshot.upsert({
          where: { clientId_date: { clientId, date } },
          create: { clientId, date, ...breakdown },
          update: breakdown,
        });
      }),
    );
    result.aiDays = ai.size;
  }

  if (client.gscSiteUrl) {
    const gsc = await fetchGscDailySeries(oauthClient, client.gscSiteUrl, startDate, endDate);
    await upsertInBatches(
      [...gsc].map(([key, metrics]) => {
        const date = dayToDate(key);
        return prisma.searchConsoleSnapshot.upsert({
          where: { clientId_date: { clientId, date } },
          create: { clientId, date, ...metrics },
          update: metrics,
        });
      }),
    );
    result.gscDays = gsc.size;
  }

  return result;
}

/** 16 months of history, ending yesterday. */
export async function importClientAnalyticsHistory(
  oauthClient: OAuth2Client,
  client: { id: string; ga4PropertyId: string | null; gscSiteUrl: string | null },
): Promise<AnalyticsSyncResult> {
  return syncClientAnalytics(oauthClient, client, utcDaysAgo(HISTORY_DAYS), utcDaysAgo(1));
}

export type ImportHistoryResult =
  | ({ ok: true } & AnalyticsSyncResult)
  | { ok: false; reason: "client_not_found" | "no_properties" | "not_connected" | "auth_expired" | "failed"; error?: string };

/**
 * Full history import for one client by id -- shared by the Settings
 * page's import button and the automatic import after a client's GA4/GSC
 * settings are saved. An expired Google token is recorded on the
 * connection row (same as the daily cron does) so /settings shows it.
 */
export async function importHistoryForClient(clientId: string): Promise<ImportHistoryResult> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, ga4PropertyId: true, gscSiteUrl: true },
  });
  if (!client) return { ok: false, reason: "client_not_found" };
  if (!client.ga4PropertyId && !client.gscSiteUrl) return { ok: false, reason: "no_properties" };

  const oauthClient = await getGoogleOAuthClient();
  if (!oauthClient) return { ok: false, reason: "not_connected" };

  try {
    const result = await importClientAnalyticsHistory(oauthClient, client);
    console.log(`[analytics-import] client ${clientId}: ${JSON.stringify(result)}`);
    return { ok: true, ...result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`[analytics-import] client ${clientId} failed: ${error}`);
    if (isAuthError(err)) {
      await prisma.googleOAuthConnection.update({ where: { id: GOOGLE_CONNECTION_ID }, data: { lastError: error } });
      return { ok: false, reason: "auth_expired", error };
    }
    return { ok: false, reason: "failed", error };
  }
}
