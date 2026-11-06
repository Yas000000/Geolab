// Aggregates the pages AI answers cited (Citation rows, Live Search only).
// Shared by the Citations page and the monthly report so both count the
// same way: a site or page is counted once per answer that cites it, no
// matter how many times that one answer links to it.

export interface CitedAnswer {
  platform: string; // RawResponse.platform (CHATGPT/CLAUDE/GEMINI)
  promptText: string;
  promptCategory: string | null;
  citations: { url: string; title: string | null; domain: string }[];
}

export interface CitedSiteRow {
  domain: string;
  isOwn: boolean;
  answers: number; // answers citing this site at least once
  sharePct: number; // answers / all answers in the set
  byPlatform: Record<string, number>;
}

export interface CitedPageRow {
  url: string;
  title: string | null;
  domain: string;
  isOwn: boolean;
  answers: number;
}

export interface CitationSummary {
  answers: number; // every Live Search answer in the set, cited or not
  answersWithCitations: number;
  answersCitingOwnSite: number;
  ownSitePct: number;
  sites: CitedSiteRow[]; // most-cited first
  pages: CitedPageRow[]; // most-cited first
}

/** The client's site as a bare host ("https://www.Example.com/about" -> "example.com"). */
export function siteDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return null;
  let host = trimmed;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    host = trimmed.replace(/^[a-z]+:\/\//, "").split("/")[0];
  }
  return host.replace(/^www\./, "") || null;
}

/** Some titles arrive URL-encoded (Wikipedia via Claude: "Mary Bridge Children%27s Hospital"). */
function readableTitle(title: string | null): string | null {
  if (!title || !/%[0-9A-Fa-f]{2}/.test(title)) return title;
  try {
    return decodeURIComponent(title);
  } catch {
    return title;
  }
}

/** True for the client's own site, including its subdomains (blog.example.com). */
export function isOwnSite(citationDomain: string, ownDomain: string | null): boolean {
  if (!ownDomain) return false;
  const d = citationDomain.toLowerCase();
  return d === ownDomain || d.endsWith(`.${ownDomain}`);
}

export function summarizeCitations(answers: CitedAnswer[], ownDomain: string | null): CitationSummary {
  const sites = new Map<string, { answers: number; byPlatform: Record<string, number> }>();
  const pages = new Map<string, CitedPageRow>();
  let answersWithCitations = 0;
  let answersCitingOwnSite = 0;

  for (const a of answers) {
    if (a.citations.length) answersWithCitations += 1;
    const domainsHere = new Set(a.citations.map((c) => c.domain.toLowerCase()));
    if ([...domainsHere].some((d) => isOwnSite(d, ownDomain))) answersCitingOwnSite += 1;
    for (const d of domainsHere) {
      const s = sites.get(d) ?? { answers: 0, byPlatform: {} };
      s.answers += 1;
      s.byPlatform[a.platform] = (s.byPlatform[a.platform] ?? 0) + 1;
      sites.set(d, s);
    }
    const urlsHere = new Set<string>();
    for (const c of a.citations) {
      if (urlsHere.has(c.url)) continue;
      urlsHere.add(c.url);
      const p = pages.get(c.url) ?? {
        url: c.url,
        title: readableTitle(c.title),
        domain: c.domain.toLowerCase(),
        isOwn: isOwnSite(c.domain, ownDomain),
        answers: 0,
      };
      p.answers += 1;
      if (!p.title && c.title) p.title = readableTitle(c.title);
      pages.set(c.url, p);
    }
  }

  const total = answers.length;
  return {
    answers: total,
    answersWithCitations,
    answersCitingOwnSite,
    ownSitePct: total ? (answersCitingOwnSite / total) * 100 : 0,
    sites: [...sites.entries()]
      .map(([domain, s]) => ({
        domain,
        isOwn: isOwnSite(domain, ownDomain),
        answers: s.answers,
        sharePct: total ? (s.answers / total) * 100 : 0,
        byPlatform: s.byPlatform,
      }))
      .sort((x, y) => y.answers - x.answers || x.domain.localeCompare(y.domain)),
    pages: [...pages.values()].sort((x, y) => y.answers - x.answers || x.url.localeCompare(y.url)),
  };
}

/** Live Search answers are the only ones that can cite anything; Training Search modelIds lack this tag. */
export function isLiveSearchModel(modelId: string | null): boolean {
  return !!modelId && modelId.toLowerCase().includes("live search");
}

/**
 * Live Search runs from before citations were saved (2026-11-06) have no
 * Citation rows at all, which would read as "cited nothing". A Live Search
 * run where no answer cited anything doesn't happen in practice, so a run
 * with zero citations across all its answers is treated as not tracked
 * for citations and left out, rather than counted as zeros.
 */
export function citationTrackedRuns<R extends { rawResponses: { citations: unknown[] }[] }>(runs: R[]): R[] {
  return runs.filter((run) => run.rawResponses.some((r) => r.citations.length > 0));
}
