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

/** Identity used to compare prompts across lists -- the same key the Rankings page groups by. */
export function promptKey(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Drops repeat prompts (case-insensitive text match, first occurrence
 * wins), regardless of category. Stricter than the Python pipeline's own
 * (category, text) dedup on purpose: the Rankings page keys rows by prompt
 * text alone, so the same text under two categories would silently merge
 * into one row there anyway.
 */
export function dedupePrompts(prompts: ParsedPrompt[]): { prompts: ParsedPrompt[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: ParsedPrompt[] = [];
  for (const p of prompts) {
    const key = promptKey(p.text);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return { prompts: unique, duplicates: prompts.length - unique.length };
}

/**
 * Inverse of parsePromptsText: renders a stored prompt list back into the
 * pasteable `## Category` format, so it can be edited and re-saved without
 * changing anything. A leading "General" group gets no header, since
 * parsePromptsText already defaults header-less lines to "General".
 */
export function formatPromptsText(prompts: { category: string | null; text: string }[]): string {
  const blocks: string[] = [];
  let currentCategory: string | null = null;
  let lines: string[] = [];

  const flush = () => {
    if (lines.length === 0) return;
    const header = blocks.length === 0 && currentCategory === DEFAULT_CATEGORY ? [] : [`## ${currentCategory}`];
    blocks.push([...header, ...lines].join("\n"));
    lines = [];
  };

  for (const p of prompts) {
    const category = p.category || DEFAULT_CATEGORY;
    if (category !== currentCategory) {
      flush();
      currentCategory = category;
    }
    lines.push(p.text);
  }
  flush();

  return blocks.join("\n\n");
}
