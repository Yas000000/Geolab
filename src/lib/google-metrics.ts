import { BetaAnalyticsDataClient, type protos } from "@google-analytics/data";
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

type Ga4Row = protos.google.analytics.data.v1beta.IRow;
type Ga4ReportRequest = protos.google.analytics.data.v1beta.IRunReportRequest;

export function normalizeGa4PropertyId(raw: string): string {
  return raw.startsWith("properties/") ? raw : `properties/${raw}`;
}

export function toApiDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * GA4's `date` dimension ("YYYYMMDD") -> "YYYY-MM-DD", the key every
 * per-day series in this app uses. Search Console's `date` key is already
 * "YYYY-MM-DD".
 */
export function ga4DayKey(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/**
 * Runs a GA4 report and follows offset pagination until every row is in.
 * The Data API caps a page at the request's `limit` (and silently defaults
 * to 10,000 unordered rows when unset -- a real undercount this project
 * shipped once, see ai-traffic.ts), and per-day x per-source breakdowns
 * over 16 months can exceed any single page.
 */
export async function runReportAllRows(client: BetaAnalyticsDataClient, request: Ga4ReportRequest): Promise<Ga4Row[]> {
  const pageSize = 100000;
  // Order by every dimension -- each row's dimension combo is unique, so
  // this is a total order and offset pages can't overlap or skip rows.
  const orderBys = request.orderBys ?? (request.dimensions ?? []).map((d) => ({ dimension: { dimensionName: d.name } }));
  const rows: Ga4Row[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const [response] = await client.runReport({ ...request, orderBys, limit: pageSize, offset });
    const page = response.rows ?? [];
    rows.push(...page);
    if (page.length < pageSize || rows.length >= (response.rowCount ?? 0)) break;
  }
  return rows;
}

/**
 * Per-day sessions/activeUsers/keyEvents for a whole date range in one
 * request (`date` dimension), keyed "YYYY-MM-DD". Days GA4 has no data for
 * are simply absent -- deliberately not filled with zeros, so days before
 * the property existed don't show up as fake zero-traffic days. Throws on
 * failure so the caller can tell auth errors apart from others.
 */
export async function fetchGa4DailySeries(
  authClient: OAuth2Client,
  propertyId: string,
  startDate: Date,
  endDate: Date,
): Promise<Map<string, Ga4DailyMetrics>> {
  try {
    const client = new BetaAnalyticsDataClient({ authClient });
    const rows = await runReportAllRows(client, {
      property: normalizeGa4PropertyId(propertyId),
      dateRanges: [{ startDate: toApiDate(startDate), endDate: toApiDate(endDate) }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "keyEvents" }],
    });

    const toInt = (v?: string | null) => (v != null && v !== "" ? parseInt(v, 10) : null);
    const series = new Map<string, Ga4DailyMetrics>();
    for (const row of rows) {
      const day = row.dimensionValues?.[0]?.value;
      if (!day) continue;
      const values = row.metricValues ?? [];
      series.set(ga4DayKey(day), {
        sessions: toInt(values[0]?.value),
        activeUsers: toInt(values[1]?.value),
        keyEvents: toInt(values[2]?.value),
      });
    }
    return series;
  } catch (err) {
    console.log(`[google-metrics] GA4 fetch failed for property ${propertyId}: ${err instanceof Error ? err.message : err}`);
    throw err; // caller distinguishes auth errors from other failures
  }
}

/**
 * Per-day Search Console totals for a whole date range in one request,
 * keyed "YYYY-MM-DD". Only finalized data is returned (the API default),
 * which lags 2-3 days -- the most recent days are simply absent until
 * Google finalizes them, which is why the daily pull re-fetches a rolling
 * window rather than just yesterday. Same error contract as above.
 */
export async function fetchGscDailySeries(
  authClient: OAuth2Client,
  siteUrl: string,
  startDate: Date,
  endDate: Date,
): Promise<Map<string, GscDailyMetrics>> {
  try {
    const searchconsole = google.searchconsole({ version: "v1", auth: authClient });
    const res = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: toApiDate(startDate),
        endDate: toApiDate(endDate),
        dimensions: ["date"],
        rowLimit: 25000,
      },
    });

    const series = new Map<string, GscDailyMetrics>();
    for (const row of res.data.rows ?? []) {
      const day = row.keys?.[0];
      if (!day) continue;
      series.set(day, {
        clicks: row.clicks ?? null,
        impressions: row.impressions ?? null,
        ctr: row.ctr ?? null,
        avgPosition: row.position ?? null,
      });
    }
    return series;
  } catch (err) {
    console.log(`[google-metrics] GSC fetch failed for site ${siteUrl}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}
