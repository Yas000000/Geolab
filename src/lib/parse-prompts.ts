export interface ParsedPrompt {
  category: string;
  text: string;
}

const DEFAULT_CATEGORY = "General";

/**
 * Parses operator-pasted prompt text into {category, text} pairs. Matches
 * the exact convention geo-rank-checker's own manual `--prompts` file
 * already uses, for consistency across this tool family: blank lines
 * ignored, `#`-prefixed lines are comments, `## Category Name` lines start
 * a new section, every other non-empty line is one prompt under the
 * current section (or "General" if no header has appeared yet).
 */
export function parsePromptsText(raw: string): ParsedPrompt[] {
  const prompts: ParsedPrompt[] = [];
  let currentCategory = DEFAULT_CATEGORY;

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("##")) {
      currentCategory = line.replace(/^#+/, "").trim() || DEFAULT_CATEGORY;
      continue;
    }
    if (line.startsWith("#")) continue; // comment

    prompts.push({ category: currentCategory, text: line });
  }

  return prompts;
}
