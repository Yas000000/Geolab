export const PLATFORM_MAP = {
  openai: "CHATGPT",
  claude: "CLAUDE",
  gemini: "GEMINI",
} as const;

export type PipelinePlatformKey = keyof typeof PLATFORM_MAP;

export type PipelineSentiment = "positive" | "neutral" | "negative" | "n/a";

export function mapSentiment(
  s: PipelineSentiment,
): "POSITIVE" | "NEUTRAL" | "NEGATIVE" | null {
  return s === "n/a" ? null : (s.toUpperCase() as "POSITIVE" | "NEUTRAL" | "NEGATIVE");
}
