export const PLATFORM_MAP = {
  openai: "CHATGPT",
  claude: "CLAUDE",
  gemini: "GEMINI",
} as const;

// DB enum value (RawResponse.platform) -> display label.
export const PLATFORM_LABEL: Record<string, string> = {
  CHATGPT: "ChatGPT",
  CLAUDE: "Claude",
  GEMINI: "Gemini",
  PERPLEXITY: "Perplexity",
};

export type PipelinePlatformKey = keyof typeof PLATFORM_MAP;

export type PipelineSentiment = "positive" | "neutral" | "negative" | "n/a";

// Prompt.category -> display label. Shared between /runs/[id] (per-run
// prompt breakdown) and /clients/[id]/rankings (aggregated prompt rankings)
// so the two stay in sync.
export const CATEGORY_LABEL: Record<string, string> = {
  best_top: "Best / Top",
  comparison: "Comparison",
  who_offers: "Who Offers",
  recommendation_by_audience: "Recommendation by Audience",
  recommendation_by_constraint: "Recommendation by Constraint",
  shortlist_vendor_selection: "Shortlist / Vendor Selection",
  location_based: "Location-Based",
};

export function mapSentiment(
  s: PipelineSentiment,
): "POSITIVE" | "NEUTRAL" | "NEGATIVE" | null {
  return s === "n/a" ? null : (s.toUpperCase() as "POSITIVE" | "NEUTRAL" | "NEGATIVE");
}
