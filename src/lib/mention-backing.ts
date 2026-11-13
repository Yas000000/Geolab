// "What backs your mentions": when an AI answer names the client, which
// cited page is linked to that part of the answer -- the client's own site,
// a third-party page, or nothing. Uses the per-claim citation spans saved
// with each Live Search crawl since 2026-11-13 (Citation.spans; Claude and
// Gemini mark the cited claim, ChatGPT marks the inline link it puts inside
// the sentence; Perplexity gives none).
//
// The unit a mention is matched in is its LIST ITEM (an AI answer is mostly
// a numbered/bulleted list of providers), else its sentence in prose. Not
// the GEO Citation tool's "the sentence, else one sentence either side": on
// real answers ChatGPT puts each item's link at the END of the item, several
// sentences after the name, so that window picked up the PREVIOUS item's
// link (live test 2026-11-12, Yellowbrick credited to thresholds.org).

import { isOwnSite } from "@/lib/citations";

export type BackingKind = "own" | "thirdParty" | "none";

export interface SpanCitation {
  url: string;
  title: string | null;
  domain: string;
  spans: unknown; // Citation.spans: [[start, end], ...] UTF-16 offsets, or null
}

export interface BackingAnswer {
  platform: string;
  text: string;
  citations: SpanCitation[];
}

interface Unit {
  start: number;
  end: number;
  kind: "item" | "sentence" | "heading";
}

// One-to-one character folds (offsets stay valid), as python_pipeline/parser.py
// normalize_text: curly quotes and non-breaking hyphens/spaces.
const FOLD: Record<string, string> = {
  "‐": "-", "‑": "-", " ": " ", " ": " ", " ": " ",
  "‘": "'", "’": "'", "“": '"', "”": '"',
};
function fold(s: string): string {
  return s.replace(/[‐‑   ‘’“”]/g, (c) => FOLD[c]);
}

// URLs and bare domains, blanked out before looking for the client's name:
// ChatGPT's inline links ("([yellowbrickprogram.com](https://...))") contain
// the brand, and the pipeline's own substring check counts those as a
// mention even when the answer never names the client (17 of 138 stored
// Yellowbrick mentions, all ChatGPT Live Search, as of 2026-11-13).
const URL_OR_DOMAIN = /\bhttps?:\/\/[^\s)\]]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)\]]*)?/gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where the answer names the client (any of `names`), outside URLs and domains. */
export function mentionPositions(text: string, names: string[]): number[] {
  const cleaned = [...new Set(names.map((n) => fold(n.trim())).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!cleaned.length || !text) return [];
  const masked = fold(text).replace(URL_OR_DOMAIN, (m) => " ".repeat(m.length));
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${cleaned.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  return [...masked.matchAll(re)].map((m) => m.index);
}

// A top-level list item ("1. ", "2) ", "- ", "* ", "• "); deeper sub-items are
// indented and stay part of their parent item.
const LIST_START = /^ ?(?:\d{1,3}[.)]|[-*•+])\s+/;
// A "### Title" line, or a line that is only bold text (Claude often heads
// each provider with one).
const HEADING = /^\s*(?:#{1,6}\s+\S|\*\*[^*\n]+\*\*:?\s*$)/;
// Sentence ends inside prose; not before "([", where ChatGPT sometimes puts
// the sentence's own link after its period.
const SENTENCE_BREAK = /(?<=[.!?])\s+(?!\(\[)/g;

/** The answer split into the units a mention is matched in. */
export function answerUnits(text: string): Unit[] {
  const units: Unit[] = [];
  let item: { start: number; end: number } | null = null;
  let para: { start: number; end: number } | null = null;
  let prevBlank = false;

  const closeItem = () => {
    if (item) units.push({ ...item, kind: "item" });
    item = null;
  };
  const closePara = () => {
    if (!para) return;
    let start = para.start;
    for (const m of text.slice(para.start, para.end).matchAll(SENTENCE_BREAK)) {
      units.push({ start, end: para.start + m.index, kind: "sentence" });
      start = para.start + m.index + m[0].length;
    }
    units.push({ start, end: para.end, kind: "sentence" });
    para = null;
  };

  let pos = 0;
  for (const line of text.split("\n")) {
    const start = pos;
    const end = pos + line.length;
    pos = end + 1;
    if (!line.trim()) {
      closePara();
      prevBlank = true;
      continue;
    }
    if (LIST_START.test(line)) {
      closePara();
      closeItem();
      item = { start, end };
    } else if (item && (!prevBlank || /^\s{2,}/.test(line))) {
      item.end = end; // the item's next line, or its indented body after a blank line
    } else if (HEADING.test(line)) {
      closePara();
      closeItem();
      units.push({ start, end, kind: "heading" });
    } else {
      closeItem();
      if (para) para.end = end;
      else para = { start, end };
    }
    prevBlank = false;
  }
  closePara();
  closeItem();
  return units.sort((a, b) => a.start - b.start);
}

function spansOf(c: SpanCitation): [number, number][] {
  return Array.isArray(c.spans)
    ? (c.spans as unknown[]).filter(
        (s): s is [number, number] => Array.isArray(s) && typeof s[0] === "number" && typeof s[1] === "number",
      )
    : [];
}

// A heading, or a line that leads into what follows ("From Yellowbrick's
// guidance, referrals should include:").
function isIntro(text: string, u: Unit): boolean {
  return u.kind === "heading" || /:\**\s*$/.test(text.slice(u.start, u.end));
}

// What an intro introduces: the unit right after it, and when that is a list
// item, the rest of that list (items with no blank line between them).
// ChatGPT links a lead-in's list once, after its last bullet (live answers,
// 2026-11-13: "Key Placement Categories (from Yellowbrick Guidance):" then
// four bullets then the yellowbrickprogram.com link).
function introducedBlock(text: string, units: Unit[], i: number): Unit[] {
  const first = units[i + 1];
  if (!first) return [];
  const block = [first];
  if (first.kind !== "item") return block;
  for (let j = i + 2; j < units.length; j++) {
    const prev = block[block.length - 1];
    if (units[j].kind !== "item" || /\n[ \t]*\n/.test(text.slice(prev.end, units[j].start))) break;
    block.push(units[j]);
  }
  return block;
}

/**
 * The pages linked to the parts of one answer that name the client, or null
 * when the answer doesn't name them. A mention in a heading or lead-in line
 * with no link of its own takes the links of what it introduces.
 */
export function backingForAnswer(
  answer: BackingAnswer,
  names: string[],
  ownDomain: string | null,
): { kind: BackingKind; pages: SpanCitation[] } | null {
  const positions = mentionPositions(answer.text, names);
  if (!positions.length) return null;
  const units = answerUnits(answer.text);
  const linked = answer.citations.map((c) => ({ c, spans: spansOf(c) }));
  const backing = (u: Unit) => linked.filter(({ spans }) => spans.some(([s, e]) => s < u.end && e > u.start)).map(({ c }) => c);

  const pages = new Map<string, SpanCitation>();
  for (const p of positions) {
    const i = units.findIndex((u) => u.start <= p && p < u.end);
    if (i < 0) continue;
    let hits = backing(units[i]);
    if (!hits.length && isIntro(answer.text, units[i])) hits = introducedBlock(answer.text, units, i).flatMap(backing);
    for (const c of hits) pages.set(c.url, c);
  }
  const list = [...pages.values()];
  const kind: BackingKind = list.some((c) => isOwnSite(c.domain, ownDomain)) ? "own" : list.length ? "thirdParty" : "none";
  return { kind, pages: list };
}

export interface BackingCounts {
  naming: number; // answers that name the client
  own: number; // ...with at least one of the client's own pages linked to the mention
  thirdParty: number; // ...with only third-party pages linked
  none: number; // ...with nothing linked to the mention
}

export interface BackingPageRow {
  url: string;
  title: string | null;
  domain: string;
  isOwn: boolean;
  answers: number;
  platforms: string[];
}

export interface MentionBackingSummary {
  answers: number; // every answer in scope
  total: BackingCounts;
  byPlatform: Record<string, BackingCounts>;
  pages: BackingPageRow[]; // pages behind mentions, most answers first
  // Answers that cite the client's site but never name the client.
  uncredited: { answers: number; byPlatform: Record<string, number>; topPage: { url: string; title: string | null; answers: number } | null };
}

const emptyCounts = (): BackingCounts => ({ naming: 0, own: 0, thirdParty: 0, none: 0 });

export function summarizeMentionBacking(
  answers: BackingAnswer[],
  names: string[],
  ownDomain: string | null,
): MentionBackingSummary {
  const total = emptyCounts();
  const byPlatform: Record<string, BackingCounts> = {};
  const pages = new Map<string, BackingPageRow>();
  const uncredited = { answers: 0, byPlatform: {} as Record<string, number> };
  const uncreditedPages = new Map<string, { url: string; title: string | null; answers: number }>();

  for (const a of answers) {
    const result = backingForAnswer(a, names, ownDomain);
    if (!result) {
      const own = [...new Map(a.citations.filter((c) => isOwnSite(c.domain, ownDomain)).map((c) => [c.url, c])).values()];
      if (own.length) {
        uncredited.answers += 1;
        uncredited.byPlatform[a.platform] = (uncredited.byPlatform[a.platform] ?? 0) + 1;
        for (const c of own) {
          const row = uncreditedPages.get(c.url) ?? { url: c.url, title: c.title, answers: 0 };
          row.answers += 1;
          uncreditedPages.set(c.url, row);
        }
      }
      continue;
    }
    const p = (byPlatform[a.platform] ??= emptyCounts());
    for (const counts of [total, p]) {
      counts.naming += 1;
      counts[result.kind] += 1;
    }
    for (const c of result.pages) {
      const row = pages.get(c.url) ?? {
        url: c.url,
        title: c.title,
        domain: c.domain.toLowerCase(),
        isOwn: isOwnSite(c.domain, ownDomain),
        answers: 0,
        platforms: [],
      };
      row.answers += 1;
      if (!row.platforms.includes(a.platform)) row.platforms.push(a.platform);
      if (!row.title && c.title) row.title = c.title;
      pages.set(c.url, row);
    }
  }

  const topUncredited = [...uncreditedPages.values()].sort((x, y) => y.answers - x.answers || x.url.localeCompare(y.url))[0];
  return {
    answers: answers.length,
    total,
    byPlatform,
    pages: [...pages.values()].sort((x, y) => y.answers - x.answers || Number(y.isOwn) - Number(x.isOwn) || x.url.localeCompare(y.url)),
    uncredited: { ...uncredited, topPage: topUncredited ?? null },
  };
}
