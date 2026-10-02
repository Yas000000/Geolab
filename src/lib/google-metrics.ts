import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export interface Ga4DailyMetrics {
  sessions: number | null;
  activeUsers: number | null;
  keyEvents: number | null;
}

export interface GscDailyMetrics {
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  avgPosition: number | null;
}

function normalizeGa4PropertyId(raw: string): string {
  return raw.startsWith("properties/") ? raw : `properties/${raw}`;
}

function toApiDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Single-day, no-dimension GA4 report -- one aggregate row for the whole
 * property. Returns null on a per-property failure (bad property ID, auth
 * error, etc.) rather than throwing, so one bad client doesn't abort the
 * rest of the daily pull loop (src/app/api/cron/analytics-pull/route.ts).
 */
export async function fetchGa4DailyMetrics(
  authClient: OAuth2Client,
  propertyId: string,
  date: Date,
): Promise<Ga4DailyMetrics | null> {
  try {
    const client = new BetaAnalyticsDataClient({ authClient });
    const dateStr = toApiDate(date);
    const [response] = await client.runReport({
      property: normalizeGa4PropertyId(propertyId),
      dateRanges: [{ startDate: dateStr, endDate: dateStr }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "keyEvents" }],
    });

    const row = response.rows?.[0];
    const values = row?.metricValues ?? [];
    const toInt = (v?: string | null) => (v != null && v !== "" ? parseInt(v, 10) : null);

    return {
      sessions: toInt(values[0]?.value),
      activeUsers: toInt(values[1]?.value),
      keyEvents: toInt(values[2]?.value),
    };
  } catch (err) {
    console.log(`[google-metrics] GA4 fetch failed for property ${propertyId}: ${err instanceof Error ? err.message : err}`);
    throw err; // caller (the cron route) distinguishes auth errors from other failures
  }
}

/**
 * Single-day, no-dimension Search Console query -- one aggregate row for
 * the whole site. Same error-propagation contract as fetchGa4DailyMetrics.
 */
export async function fetchGscDailyMetrics(
  authClient: OAuth2Client,
  siteUrl: string,
  date: Date,
): Promise<GscDailyMetrics | null> {
  try {
    const searchconsole = google.searchconsole({ version: "v1", auth: authClient });
    const dateStr = toApiDate(date);
    const res = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: { startDate: dateStr, endDate: dateStr },
    });

    const row = res.data.rows?.[0];
    if (!row) return { clicks: null, impressions: null, ctr: null, avgPosition: null };

    return {
      clicks: row.clicks ?? null,
      impressions: row.impressions ?? null,
      ctr: row.ctr ?? null,
      avgPosition: row.position ?? null,
    };
  } catch (err) {
    console.log(`[google-metrics] GSC fetch failed for site ${siteUrl}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}
