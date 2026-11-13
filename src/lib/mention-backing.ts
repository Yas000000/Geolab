// "What backs your mentions": when an AI answer mentions the client, which
// cited page is linked to that mention -- the client's own site, a
// third-party page, or nothing. Uses the per-claim citation spans saved
// with each Live Search crawl since 2026-11-13 (Citation.spans; Claude and
// Gemini mark the cited claim, ChatGPT marks the inline link it puts inside
// the sentence; Perplexity gives none).
//
// A mention is ANY reference to the client (user's rule, 2026-11-12: "the
// domain counts as a mention too no matter how it's referenced"): the name
// in the text, the client's domain in the text (ChatGPT's inline
// "([yellowbrickprogram.com](https://...))" links), or the client's site
// cited as a source. So an answer that cites the client's site anywhere is
// a mention backed by the client's own site.
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where the answer references the client: any of `names` as a whole word
 * (also inside a link or URL path), or the client's own domain anywhere
 * ("yellowbrickprogram.com", inside links and URLs too).
 */
export function mentionPositions(text: string, names: string[], ownDomain: string | null = null): number[] {
  const cleaned = [...new Set(names.map((n) => fold(n.trim())).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!text || (!cleaned.length && !ownDomain)) return [];
  const parts = cleaned.map((n) => `(?<![\\p{L}\\p{N}_])${escapeRegExp(n)}(?![\\p{L}\\p{N}_])`);
  if (ownDomain) parts.push(escapeRegExp(ownDomain));
  const re = new RegExp(parts.join("|"), "giu");
  return [...fold(text).matchAll(re)].map((m) => m.index);
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
 * The pages behind one answer's mentions of the client, or null when the
 * answer doesn't mention them. Each place the text references the client is
 * matched to the links of its unit (a mention in a heading or lead-in line
 * with no link of its own takes the links of what it introduces); every page
 * of the client's own site the answer cites is a mention in itself, so it
 * makes the answer "own" wherever it is.
 */
export function backingForAnswer(
  answer: BackingAnswer,
  names: string[],
  ownDomain: string | null,
): { kind: BackingKind; pages: SpanCitation[] } | null {
  const ownCited = answer.citations.filter((c) => isOwnSite(c.domain, ownDomain));
  const positions = mentionPositions(answer.text, names, ownDomain);
  if (!positions.length && !ownCited.length) return null;
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
  for (const c of ownCited) pages.set(c.url, c);
  const list = [...pages.values()];
  const kind: BackingKind = ownCited.length ? "own" : list.length ? "thirdParty" : "none";
  return { kind, pages: list };
}

export interface BackingCounts {
  mentioning: number; // answers that mention the client (name, domain or own site cited)
  own: number; // ...that link at least one of the client's own pages
  thirdParty: number; // ...with only third-party pages linked to the mention
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
}

const emptyCounts = (): BackingCounts => ({ mentioning: 0, own: 0, thirdParty: 0, none: 0 });

export function summarizeMentionBacking(
  answers: BackingAnswer[],
  names: string[],
  ownDomain: string | null,
): MentionBackingSummary {
  const total = emptyCounts();
  const byPlatform: Record<string, BackingCounts> = {};
  const pages = new Map<string, BackingPageRow>();

  for (const a of answers) {
    const result = backingForAnswer(a, names, ownDomain);
    if (!result) continue;
    const p = (byPlatform[a.platform] ??= emptyCounts());
    for (const counts of [total, p]) {
      counts.mentioning += 1;
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

  return {
    answers: answers.length,
    total,
    byPlatform,
    pages: [...pages.values()].sort((x, y) => y.answers - x.answers || Number(y.isOwn) - Number(x.isOwn) || x.url.localeCompare(y.url)),
  };
}
