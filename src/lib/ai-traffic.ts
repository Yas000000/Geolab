import { BetaAnalyticsDataClient } from "@google-analytics/data";
import type { OAuth2Client } from "google-auth-library";
import { ga4DayKey, normalizeGa4PropertyId, runReportAllRows, toApiDate } from "@/lib/google-metrics";

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

/**
 * Three GA4 Data API calls for one client/range, each split by day (`date`
 * dimension), keyed "YYYY-MM-DD": the native channel-group totals
 * (Direct/AI Assistant/Referral/Unassigned, confirmed live to be real enum
 * values returned by sessionDefaultChannelGroup -- an earlier doc summary
 * wrongly claimed they weren't), then a drill-down into Referral's sources
 * and Unassigned's sources + mediums to find the AI-attributable subset of
 * each. Unassigned once matched the medium only, which found NOTHING for any
 * client: checked live 2026-11-20, every AI visit in Unassigned names the
 * platform in its source with medium "(not set)"/"(none)" (MacuMira
 * openai + chatgpt.com, Yellowbrick gemini, Golden copilot.com, openai,
 * perplexity) -- AI apps tag links with utm_source and no utm_medium.
 * Referral and Unassigned are catch-all buckets, not AI-specific --
 * live-verified on real data that most of their volume is NOT AI traffic
 * (SignUp: 0.0% of Referral, 0.07% of Unassigned), so the whole-bucket
 * totals are stored for context but the *Ai subfields are the real signal.
 *
 * One call covers any range, from the daily pull's rolling window to a
 * 16-month history import. Every query goes through runReportAllRows: the
 * Data API defaults to a 10,000-row limit with NO row ordering when unset
 * -- live-confirmed SignUp's Referral channel alone has 14,475+ distinct
 * sources within a single quarter, so the unpaginated default silently
 * dropped an unknown slice of rows (a real undercount this project shipped
 * before catching it), and day x source rows multiply that further.
 *
 * Days with no sessions at all are absent, not zero-filled (same reasoning
 * as fetchGa4DailySeries). Throws on error so the caller's auth-error
 * handling (isAuthError) keeps working.
 */
export async function fetchAiTrafficDailySeries(
  authClient: OAuth2Client,
  propertyId: string,
  startDate: Date,
  endDate: Date,
): Promise<Map<string, AiTrafficBreakdown>> {
  try {
    const client = new BetaAnalyticsDataClient({ authClient });
    const property = normalizeGa4PropertyId(propertyId);
    const dateRanges = [{ startDate: toApiDate(startDate), endDate: toApiDate(endDate) }];
    const day = (row: { dimensionValues?: { value?: string | null }[] | null }) =>
      ga4DayKey(row.dimensionValues?.[0]?.value ?? "");
    const sessionsOf = (row: { metricValues?: { value?: string | null }[] | null }) =>
      parseInt(row.metricValues?.[0]?.value ?? "0", 10);

    const channelRows = await runReportAllRows(client, {
      property,
      dateRanges,
      dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
    });

    const series = new Map<string, AiTrafficBreakdown>();
    const entry = (key: string) => {
      let e = series.get(key);
      if (!e) {
        e = {
          directSessions: 0,
          aiAssistantSessions: 0,
          referralSessions: 0,
          referralAiSessions: 0,
          unassignedSessions: 0,
          unassignedAiSessions: 0,
        };
        series.set(key, e);
      }
      return e;
    };
    for (const row of channelRows) {
      const e = entry(day(row));
      const sessions = sessionsOf(row);
      switch (row.dimensionValues?.[1]?.value) {
        case "Direct":
          e.directSessions = sessions;
          break;
        case "AI Assistant":
          e.aiAssistantSessions = sessions;
          break;
        case "Referral":
          e.referralSessions = sessions;
          break;
        case "Unassigned":
          e.unassignedSessions = sessions;
          break;
      }
    }

    const anyReferral = [...series.values()].some((e) => (e.referralSessions ?? 0) > 0);
    if (anyReferral) {
      const referralRows = await runReportAllRows(client, {
        property,
        dateRanges,
        dimensions: [{ name: "date" }, { name: "sessionSource" }],
        metrics: [{ name: "sessions" }],
        dimensionFilter: {
          filter: {
            fieldName: "sessionDefaultChannelGroup",
            stringFilter: { matchType: "EXACT", value: "Referral" },
          },
        },
      });
      for (const row of referralRows) {
        if (matchesAiPlatform(row.dimensionValues?.[1]?.value)) {
          const e = entry(day(row));
          e.referralAiSessions = (e.referralAiSessions ?? 0) + sessionsOf(row);
        }
      }
    }

    const anyUnassigned = [...series.values()].some((e) => (e.unassignedSessions ?? 0) > 0);
    if (anyUnassigned) {
      const unassignedRows = await runReportAllRows(client, {
        property,
        dateRanges,
        dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" }],
        metrics: [{ name: "sessions" }],
        dimensionFilter: {
          filter: {
            fieldName: "sessionDefaultChannelGroup",
            stringFilter: { matchType: "EXACT", value: "Unassigned" },
          },
        },
      });
      for (const row of unassignedRows) {
        // Source or medium: one row per source/medium pair, so a visit is never counted twice.
        if (matchesAiPlatform(row.dimensionValues?.[1]?.value) || matchesAiPlatform(row.dimensionValues?.[2]?.value)) {
          const e = entry(day(row));
          e.unassignedAiSessions = (e.unassignedAiSessions ?? 0) + sessionsOf(row);
        }
      }
    }

    return series;
  } catch (err) {
    console.log(`[ai-traffic] GA4 fetch failed for property ${propertyId}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

export interface CountryTrafficDay extends AiTrafficBreakdown {
  sessions: number | null;
  activeUsers: number | null;
  keyEvents: number | null;
}

/**
 * The same daily figures as fetchGa4DailySeries + fetchAiTrafficDailySeries,
 * split by visitor country (GA4's countryId, ISO alpha-2) and pulled only
 * for `countries` -- the countries of a client's locations. Keyed
 * "YYYY-MM-DD|CC". One property covers every country: MacuMira's main
 * property also records its ca. and anz. subdomains (checked live
 * 2026-11-20), so a location's traffic is the property's visits from that
 * country, whichever subdomain they landed on.
 *
 * A day/country with no sessions is absent. AI fields are 0 (not null) on
 * any day/country that has sessions, matching the whole-site series.
 */
export async function fetchCountryTrafficDailySeries(
  authClient: OAuth2Client,
  propertyId: string,
  countries: string[],
  startDate: Date,
  endDate: Date,
): Promise<Map<string, CountryTrafficDay>> {
  const series = new Map<string, CountryTrafficDay>();
  if (!countries.length) return series;
  try {
    const client = new BetaAnalyticsDataClient({ authClient });
    const property = normalizeGa4PropertyId(propertyId);
    const dateRanges = [{ startDate: toApiDate(startDate), endDate: toApiDate(endDate) }];
    const inCountries = { filter: { fieldName: "countryId", inListFilter: { values: countries } } };
    const inChannel = (value: string) => ({
      andGroup: {
        expressions: [inCountries, { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT" as const, value } } }],
      },
    });
    const keyOf = (row: { dimensionValues?: { value?: string | null }[] | null }) =>
      `${ga4DayKey(row.dimensionValues?.[0]?.value ?? "")}|${row.dimensionValues?.[1]?.value ?? ""}`;
    const toInt = (v?: string | null) => (v != null && v !== "" ? parseInt(v, 10) : null);
    const sessionsOf = (row: { metricValues?: { value?: string | null }[] | null }) =>
      parseInt(row.metricValues?.[0]?.value ?? "0", 10);
    const entry = (key: string) => {
      let e = series.get(key);
      if (!e) {
        e = {
          sessions: null,
          activeUsers: null,
          keyEvents: null,
          directSessions: 0,
          aiAssistantSessions: 0,
          referralSessions: 0,
          referralAiSessions: 0,
          unassignedSessions: 0,
          unassignedAiSessions: 0,
        };
        series.set(key, e);
      }
      return e;
    };

    const totals = await runReportAllRows(client, {
      property,
      dateRanges,
      dimensions: [{ name: "date" }, { name: "countryId" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "keyEvents" }],
      dimensionFilter: inCountries,
    });
    for (const row of totals) {
      const e = entry(keyOf(row));
      const v = row.metricValues ?? [];
      e.sessions = toInt(v[0]?.value);
      e.activeUsers = toInt(v[1]?.value);
      e.keyEvents = toInt(v[2]?.value);
    }

    const channels = await runReportAllRows(client, {
      property,
      dateRanges,
      dimensions: [{ name: "date" }, { name: "countryId" }, { name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      dimensionFilter: inCountries,
    });
    for (const row of channels) {
      const e = entry(keyOf(row));
      const sessions = sessionsOf(row);
      switch (row.dimensionValues?.[2]?.value) {
        case "Direct":
          e.directSessions = sessions;
          break;
        case "AI Assistant":
          e.aiAssistantSessions = sessions;
          break;
        case "Referral":
          e.referralSessions = sessions;
          break;
        case "Unassigned":
          e.unassignedSessions = sessions;
          break;
      }
    }

    // The AI share of Referral (by source) and Unassigned (by source or medium), as in fetchAiTrafficDailySeries.
    const drillDowns: [string, string[], "referralAiSessions" | "unassignedAiSessions"][] = [
      ["Referral", ["sessionSource"], "referralAiSessions"],
      ["Unassigned", ["sessionSource", "sessionMedium"], "unassignedAiSessions"],
    ];
    for (const [channel, dimensions, field] of drillDowns) {
      const bucket = field === "referralAiSessions" ? "referralSessions" : "unassignedSessions";
      if (![...series.values()].some((e) => (e[bucket] ?? 0) > 0)) continue;
      const rows = await runReportAllRows(client, {
        property,
        dateRanges,
        dimensions: [{ name: "date" }, { name: "countryId" }, ...dimensions.map((name) => ({ name }))],
        metrics: [{ name: "sessions" }],
        dimensionFilter: inChannel(channel),
      });
      for (const row of rows) {
        if ((row.dimensionValues ?? []).slice(2).some((v) => matchesAiPlatform(v?.value))) {
          const e = entry(keyOf(row));
          e[field] = (e[field] ?? 0) + sessionsOf(row);
        }
      }
    }
    return series;
  } catch (err) {
    console.log(`[ai-traffic] GA4 country fetch failed for property ${propertyId}: ${err instanceof Error ? err.message : err}`);
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
