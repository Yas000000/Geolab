import { BetaAnalyticsDataClient } from "@google-analytics/data";
import type { OAuth2Client } from "google-auth-library";

export interface AiTrafficBreakdown {
  directSessions: number | null;
  aiAssistantSessions: number | null;
  referralSessions: number | null;
  referralAiSessions: number | null;
  unassignedSessions: number | null;
  unassignedAiSessions: number | null;
}

/**
 * Known AI platform identifiers, matched with a word-boundary regex per
 * entry -- NEVER String.includes(). A bare substring check against "you.com"
 * false-positived on "sportsyou.com" (a real client's genuine, unrelated
 * referral source) during live testing; this list exists specifically to
 * avoid repeating that mistake, same failure class as this project family's
 * recurring SignUp/SignUpGenius substring-collision lesson.
 */
export const AI_PLATFORM_NAMES = [
  "perplexity",
  "claude",
  "chatgpt",
  "openai",
  "copilot",
  "copilot.com",
  "gemini",
  "deepseek",
  "grok",
  "meta.ai",
  "poe.com",
  "you.com",
];

const AI_PLATFORM_PATTERN = new RegExp(
  `\\b(${AI_PLATFORM_NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

function matchesAiPlatform(value: string | null | undefined): boolean {
  if (!value) return false;
  return AI_PLATFORM_PATTERN.test(value);
}

function normalizePropertyId(raw: string): string {
  return raw.startsWith("properties/") ? raw : `properties/${raw}`;
}

function toApiDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Three GA4 Data API calls for one client/day: the native channel-group
 * totals (Direct/AI Assistant/Referral/Unassigned, confirmed live to be
 * real enum values returned by sessionDefaultChannelGroup -- an earlier doc
 * summary wrongly claimed they weren't), then a drill-down into Referral's
 * sources and Unassigned's mediums to find the AI-attributable subset of
 * each. Referral and Unassigned are catch-all buckets, not AI-specific --
 * live-verified on real data that most of their volume is NOT AI traffic
 * (SignUp: 0.0% of Referral, 0.07% of Unassigned), so the whole-bucket
 * totals are stored for context but the *Ai subfields are the real signal.
 *
 * Same null-on-no-data / throw-on-error contract as fetchGa4DailyMetrics in
 * google-metrics.ts, so the caller's existing auth-error handling (the cron
 * route's isAuthError short-circuit) keeps working unchanged.
 */
export async function fetchAiTrafficBreakdown(
  authClient: OAuth2Client,
  propertyId: string,
  date: Date,
): Promise<AiTrafficBreakdown | null> {
  try {
    const client = new BetaAnalyticsDataClient({ authClient });
    const dateStr = toApiDate(date);
    const property = normalizePropertyId(propertyId);
    const dateRanges = [{ startDate: dateStr, endDate: dateStr }];

    const [channelResponse] = await client.runReport({
      property,
      dateRanges,
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
    });

    const totals: Record<string, number> = {};
    for (const row of channelResponse.rows ?? []) {
      const group = row.dimensionValues?.[0]?.value ?? "";
      const sessions = parseInt(row.metricValues?.[0]?.value ?? "0", 10);
      totals[group] = sessions;
    }

    const directSessions = totals["Direct"] ?? 0;
    const aiAssistantSessions = totals["AI Assistant"] ?? 0;
    const referralSessions = totals["Referral"] ?? 0;
    const unassignedSessions = totals["Unassigned"] ?? 0;

    let referralAiSessions = 0;
    if (referralSessions > 0) {
      const [referralResponse] = await client.runReport({
        property,
        dateRanges,
        dimensions: [{ name: "sessionSource" }],
        metrics: [{ name: "sessions" }],
        dimensionFilter: {
          filter: {
            fieldName: "sessionDefaultChannelGroup",
            stringFilter: { matchType: "EXACT", value: "Referral" },
          },
        },
      });
      for (const row of referralResponse.rows ?? []) {
        const source = row.dimensionValues?.[0]?.value;
        if (matchesAiPlatform(source)) {
          referralAiSessions += parseInt(row.metricValues?.[0]?.value ?? "0", 10);
        }
      }
    }

    let unassignedAiSessions = 0;
    if (unassignedSessions > 0) {
      const [unassignedResponse] = await client.runReport({
        property,
        dateRanges,
        dimensions: [{ name: "sessionMedium" }],
        metrics: [{ name: "sessions" }],
        dimensionFilter: {
          filter: {
            fieldName: "sessionDefaultChannelGroup",
            stringFilter: { matchType: "EXACT", value: "Unassigned" },
          },
        },
      });
      for (const row of unassignedResponse.rows ?? []) {
        const medium = row.dimensionValues?.[0]?.value;
        if (matchesAiPlatform(medium)) {
          unassignedAiSessions += parseInt(row.metricValues?.[0]?.value ?? "0", 10);
        }
      }
    }

    return {
      directSessions,
      aiAssistantSessions,
      referralSessions,
      referralAiSessions,
      unassignedSessions,
      unassignedAiSessions,
    };
  } catch (err) {
    console.log(`[ai-traffic] GA4 fetch failed for property ${propertyId}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

/**
 * Attrifast's 2026 AI Search Revenue Benchmark (200 Stripe-connected SMB
 * sites, Nov 2025-May 2026): 34% of GA4 Direct/(none) traffic is actually
 * AI-referred, IQR 21-47%. No per-session detection signal exists for
 * Direct (no referrer at all) -- this is an external estimate applied at
 * render time, never stored as fact. See reference_ga4_ai_traffic memory
 * for the full methodology and by-vertical breakdown.
 */
export const DIRECT_AI_SHARE_ESTIMATE = { low: 0.21, mid: 0.34, high: 0.47 };

export function estimateDirectAiSessions(directSessions: number) {
  return {
    low: Math.round(directSessions * DIRECT_AI_SHARE_ESTIMATE.low),
    mid: Math.round(directSessions * DIRECT_AI_SHARE_ESTIMATE.mid),
    high: Math.round(directSessions * DIRECT_AI_SHARE_ESTIMATE.high),
  };
}
