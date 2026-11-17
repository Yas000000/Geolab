// The GEO Rankings tab's Competitors table, shared with the client report so
// the two always show the same numbers for the same answers:
//   Rank           by mentions, most first
//   Position       average list position when mentioned
//   Visibility     mentions / answers
//   Share of Voice mentions / all brands' mentions

export interface MentionLike {
  position: number | null;
  rawLabel: string;
  brand: { id: string; name: string; isClientBrand: boolean } | null;
}

export interface AnswerLike {
  parsedResult: { mentions: MentionLike[] } | null;
}

export interface CompetitorStat {
  key: string; // brand id, or "raw:<label>" for an unresolved name
  name: string;
  isClientBrand: boolean;
  appearances: number;
  avgPosition: number | null;
  visibilityPct: number;
  sharePct: number;
}

export function competitorStats(answers: AnswerLike[]): CompetitorStat[] {
  const acc = new Map<string, { name: string; isClientBrand: boolean; appearances: number; positions: number[] }>();
  for (const r of answers) {
    for (const m of r.parsedResult?.mentions ?? []) {
      const key = m.brand?.id ?? `raw:${m.rawLabel.toLowerCase()}`;
      const e = acc.get(key) ?? { name: m.brand?.name ?? m.rawLabel, isClientBrand: m.brand?.isClientBrand ?? false, appearances: 0, positions: [] };
      e.appearances += 1;
      if (m.position != null) e.positions.push(m.position);
      acc.set(key, e);
    }
  }
  const totalAppearances = [...acc.values()].reduce((a, e) => a + e.appearances, 0);
  return [...acc.entries()]
    .map(([key, e]) => ({
      key,
      name: e.name,
      isClientBrand: e.isClientBrand,
      appearances: e.appearances,
      avgPosition: e.positions.length ? e.positions.reduce((a, c) => a + c, 0) / e.positions.length : null,
      visibilityPct: answers.length ? (e.appearances / answers.length) * 100 : 0,
      sharePct: totalAppearances ? (e.appearances / totalAppearances) * 100 : 0,
    }))
    .sort((a, b) => b.appearances - a.appearances);
}

// ── Matching an imported benchmark's competitor names to tracked brands ─────
// A benchmark document can name competitors by website (mcleanhospital.org,
// rogersbh.org) while the portal names brands (McLean Hospital, Rogers
// Behavioral Health). Matches are exact on these keys, never fuzzy; adding the
// website as an alias on the Competitors tab always makes a match.

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Keys a name can match on: itself, or for a website its name minus the ending and its first part. */
export function nameKeys(name: string): string[] {
  const n = name.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(n)) {
    const labels = n.split(".");
    labels.pop(); // .org, .com, .edu ...
    return [...new Set([alnum(labels.join("")), alnum(labels[0])])].filter(Boolean);
  }
  return [alnum(n)].filter(Boolean);
}

/** "Rogers Behavioral Health" -> "rogersbh": first word plus the initials of the rest (a common website style). */
function shortKey(name: string): string | null {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length >= 2 ? words[0] + words.slice(1).map((w) => w[0]).join("") : null;
}

export interface BrandForMatch {
  id: string;
  name: string;
  aliases: string[];
}

/**
 * The tracked brand each benchmark name refers to (benchmark name -> brand id).
 * Tries each of the name's keys against brand names and aliases, then the
 * first-word-plus-initials form. Several candidates: the one with the most
 * mentions in `weight` wins. No candidate: no entry.
 */
export function matchBenchmarkNames(names: string[], brands: BrandForMatch[], weight: Map<string, number>): Map<string, string> {
  const exact = new Map<string, string[]>();
  const loose = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, id: string) => m.set(k, [...new Set([...(m.get(k) ?? []), id])]);
  for (const b of brands) {
    for (const k of [...nameKeys(b.name), ...b.aliases.flatMap(nameKeys)]) add(exact, k, b.id);
    const s = shortKey(b.name);
    if (s) add(loose, s, b.id);
  }
  const pick = (ids: string[]) => [...ids].sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))[0];
  const out = new Map<string, string>();
  for (const name of names) {
    const keys = nameKeys(name);
    const hit = keys.map((k) => exact.get(k)).find((ids) => ids?.length) ?? keys.map((k) => loose.get(k)).find((ids) => ids?.length);
    if (hit) out.set(name, pick(hit));
  }
  return out;
}
