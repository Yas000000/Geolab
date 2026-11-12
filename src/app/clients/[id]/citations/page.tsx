import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ModelFilter } from "@/components/model-filter";
import { DateRangePicker } from "@/components/date-range-picker";
import { PLATFORM_LABEL } from "@/lib/geo-platform-map";
import { geoAllTimeRange, parseISODate, resolveComparisonRange, type CompareMode, type DateRange } from "@/lib/date-range";
import { citationTrackedRuns, siteDomain, summarizeCitations, type CitedAnswer } from "@/lib/citations";

export const dynamic = "force-dynamic";

const LIVE_SEARCH_TAG = "live search"; // in every Live Search RawResponse.modelId (python_pipeline/platforms.py)

async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      domain: true,
      benchmarkSnapshots: { select: { snapshotDate: true } },
      runs: {
        where: { status: "COMPLETE" },
        orderBy: { startedAt: "asc" },
        select: {
          id: true,
          startedAt: true,
          rawResponses: {
            // Empty text = the call failed (e.g. Gemini's 429 quota errors); not an answer.
            where: { modelId: { contains: LIVE_SEARCH_TAG, mode: "insensitive" }, responseText: { not: "" } },
            select: {
              platform: true,
              prompt: { select: { text: true, category: true } },
              citations: { orderBy: { position: "asc" }, select: { url: true, title: true, domain: true } },
            },
          },
        },
      },
    },
  });
}

type ClientData = NonNullable<Awaited<ReturnType<typeof getClient>>>;

function inWindow(date: Date, range: DateRange | null): boolean {
  if (!range) return true;
  const endExclusive = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 1);
  return date.getTime() >= range.start.getTime() && date.getTime() < endExclusive.getTime();
}

function answersIn(client: ClientData, range: DateRange | null, platform: string | undefined): CitedAnswer[] {
  return citationTrackedRuns(client.runs)
    .filter((run) => inWindow(run.startedAt, range))
    .flatMap((run) => run.rawResponses)
    .filter((r) => !platform || r.platform === platform)
    .map((r) => ({
      platform: r.platform,
      promptText: r.prompt.text,
      promptCategory: r.prompt.category,
      citations: r.citations,
    }));
}

function Delta({ value, unit = "pp" }: { value: number | null; unit?: string }) {
  if (value == null) return <span className="text-zinc-300 dark:text-zinc-700">—</span>;
  const cls =
    value > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : value < 0
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-400 dark:text-zinc-600";
  return (
    <span className={cls}>
      {value > 0 ? "▲" : value < 0 ? "▼" : "–"} {Math.abs(value).toFixed(1)}
      {unit}
    </span>
  );
}

function YouBadge() {
  return (
    <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-900 dark:text-blue-200">
      You
    </span>
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return u.hostname.replace(/^www\./, "") + path;
  } catch {
    return url;
  }
}

export default async function ClientCitationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const platformFilter = typeof sp.model === "string" && sp.model ? sp.model : undefined;

  const startParam = typeof sp.start === "string" ? sp.start : undefined;
  const endParam = typeof sp.end === "string" ? sp.end : undefined;
  const dateRange: DateRange | null =
    startParam && endParam ? { start: parseISODate(startParam), end: parseISODate(endParam) } : null;
  const compareMode = (typeof sp.compare === "string" ? sp.compare : "none") as CompareMode;
  const compareStartParam = typeof sp.compareStart === "string" ? sp.compareStart : undefined;
  const compareEndParam = typeof sp.compareEnd === "string" ? sp.compareEnd : undefined;
  const customCompareRange: DateRange | null =
    compareStartParam && compareEndParam
      ? { start: parseISODate(compareStartParam), end: parseISODate(compareEndParam) }
      : null;
  const comparisonRange = resolveComparisonRange(dateRange, compareMode, customCompareRange);

  const client = await getClient(id);
  if (!client) notFound();

  const ownDomain = siteDomain(client.domain);
  const allTimeRange = geoAllTimeRange(
    client.runs.map((r) => r.startedAt),
    client.benchmarkSnapshots.map((s) => s.snapshotDate),
  );
  const platformsAvailable = Array.from(
    new Set(citationTrackedRuns(client.runs).flatMap((run) => run.rawResponses.map((r) => r.platform))),
  ).sort();

  const primaryAnswers = answersIn(client, dateRange, platformFilter);
  const summary = summarizeCitations(primaryAnswers, ownDomain);
  const comparisonAnswers = comparisonRange ? answersIn(client, comparisonRange, platformFilter) : [];
  const comparison = comparisonAnswers.length ? summarizeCitations(comparisonAnswers, ownDomain) : null;
  const comparisonShare = new Map(comparison?.sites.map((s) => [s.domain, s.sharePct]) ?? []);
  const ownPages = summary.pages.filter((p) => p.isOwn);

  // Per prompt: how many answers, how many cite the client, and the sites cited most.
  const byPrompt = new Map<string, CitedAnswer[]>();
  for (const a of primaryAnswers) {
    const key = a.promptText.trim().toLowerCase();
    byPrompt.set(key, [...(byPrompt.get(key) ?? []), a]);
  }
  const promptRows = [...byPrompt.values()]
    .map((answers) => ({ text: answers[0].promptText, summary: summarizeCitations(answers, ownDomain) }))
    .sort((a, b) => b.summary.answersCitingOwnSite - a.summary.answersCitingOwnSite || a.text.localeCompare(b.text));

  const ownSiteDelta = comparison ? summary.ownSitePct - comparison.ownSitePct : null;
  const card = "rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950";
  const cardLabel = "text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
  const sectionTitle = "mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
  const thead = "bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400";

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}</h1>
          {client.domain && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <ModelFilter platforms={platformsAvailable.map((p) => ({ key: p, label: PLATFORM_LABEL[p] ?? p }))} />
          <DateRangePicker allTimeRange={allTimeRange} />
        </div>
      </header>

      {summary.answers === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          No Live Search answers with citations in this range{platformFilter ? " for this platform" : ""}. Citations
          only come from Live Search, since Training Search answers from the AI&apos;s memory and cites nothing, and
          Live Search runs from before November 6, 2026 didn&apos;t save them. Run a Live Search from{" "}
          <a href={`/clients/${id}/settings`} className="underline">
            Settings
          </a>
          .
        </div>
      ) : (
        <>
          <section className="mb-8 grid gap-3 sm:grid-cols-3">
            <div className={card}>
              <div className={cardLabel}>Answers Citing Your Site</div>
              <div className="mt-1 flex items-baseline gap-3">
                <div className="text-3xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                  {summary.ownSitePct.toFixed(1)}%
                </div>
                {ownSiteDelta != null && (
                  <span className="text-sm font-medium tabular-nums">
                    <Delta value={ownSiteDelta} />
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {summary.answersCitingOwnSite} of {summary.answers} answer{summary.answers === 1 ? "" : "s"}
                {ownDomain ? ` link to ${ownDomain}` : ""}
              </div>
            </div>
            <div className={card}>
              <div className={cardLabel}>Answers With Sources</div>
              <div className="mt-1 text-3xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                {summary.answersWithCitations}
              </div>
              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                of {summary.answers} Live Search answer{summary.answers === 1 ? "" : "s"} cited at least one page
              </div>
            </div>
            <div className={card}>
              <div className={cardLabel}>Sites Cited</div>
              <div className="mt-1 text-3xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
                {summary.sites.length}
              </div>
              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {summary.pages.length} different page{summary.pages.length === 1 ? "" : "s"}
                {platformFilter ? ` · ${PLATFORM_LABEL[platformFilter] ?? platformFilter} only` : ""}
              </div>
            </div>
          </section>

          <section className="mb-8">
            <h2 className={sectionTitle}>Most Cited Sites</h2>
            <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
              The sites AI answers link to as sources for this client&apos;s prompts. Share is the % of answers that
              cite the site at least once.
              {comparison ? " Change is vs. the comparison period." : " Pick a \"Compare To\" period to see Change."}
            </p>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead className={thead}>
                  <tr>
                    <th className="px-4 py-2 font-medium">Rank</th>
                    <th className="px-4 py-2 font-medium">Site</th>
                    <th className="px-4 py-2 text-right font-medium tabular-nums">Answers</th>
                    <th className="px-4 py-2 text-right font-medium tabular-nums">Share</th>
                    {platformsAvailable.map((p) => (
                      <th key={p} className="px-3 py-2 text-right font-medium tabular-nums">
                        {PLATFORM_LABEL[p] ?? p}
                      </th>
                    ))}
                    {comparison && <th className="px-4 py-2 text-right font-medium tabular-nums">Change</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                  {summary.sites.slice(0, 25).map((s, i) => (
                    <tr key={s.domain} className={s.isOwn ? "bg-blue-50 dark:bg-blue-950/40" : "bg-white dark:bg-zinc-950"}>
                      <td className="px-4 py-2 tabular-nums text-zinc-500 dark:text-zinc-400">#{i + 1}</td>
                      <td className="px-4 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                        {s.domain}
                        {s.isOwn && <YouBadge />}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{s.answers}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{s.sharePct.toFixed(1)}%</td>
                      {platformsAvailable.map((p) => (
                        <td key={p} className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                          {s.byPlatform[p] ?? <span className="text-zinc-300 dark:text-zinc-700">—</span>}
                        </td>
                      ))}
                      {comparison && (
                        <td className="px-4 py-2 text-right tabular-nums">
                          <Delta value={s.sharePct - (comparisonShare.get(s.domain) ?? 0)} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summary.sites.length > 25 && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Showing the top 25 of {summary.sites.length} sites.
              </p>
            )}
          </section>

          <section className="mb-8">
            <h2 className={sectionTitle}>Your Cited Pages</h2>
            {ownPages.length === 0 ? (
              <div className="mt-3 rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                No answer in this range cited a page on {ownDomain ?? "the client's site"}.
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className={thead}>
                    <tr>
                      <th className="px-4 py-2 font-medium">Page</th>
                      <th className="px-4 py-2 text-right font-medium tabular-nums">Answers</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    {ownPages.map((p) => (
                      <tr key={p.url} className="bg-white dark:bg-zinc-950">
                        <td className="px-4 py-2">
                          <a href={p.url} target="_blank" rel="noreferrer" className="text-blue-700 underline dark:text-blue-400">
                            {p.title ?? shortUrl(p.url)}
                          </a>
                          <div className="text-xs break-all text-zinc-400 dark:text-zinc-500">{shortUrl(p.url)}</div>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{p.answers}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="mb-8">
            <h2 className={sectionTitle}>Most Cited Pages</h2>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead className={thead}>
                  <tr>
                    <th className="px-4 py-2 font-medium">Page</th>
                    <th className="px-4 py-2 font-medium">Site</th>
                    <th className="px-4 py-2 text-right font-medium tabular-nums">Answers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                  {summary.pages.slice(0, 25).map((p) => (
                    <tr key={p.url} className={p.isOwn ? "bg-blue-50 dark:bg-blue-950/40" : "bg-white dark:bg-zinc-950"}>
                      <td className="px-4 py-2">
                        <a href={p.url} target="_blank" rel="noreferrer" className="text-blue-700 underline dark:text-blue-400">
                          {p.title ?? shortUrl(p.url)}
                        </a>
                        <div className="text-xs break-all text-zinc-400 dark:text-zinc-500">{shortUrl(p.url)}</div>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                        {p.domain}
                        {p.isOwn && <YouBadge />}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{p.answers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className={sectionTitle}>Citations by Prompt</h2>
            <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
              For each prompt: how many answers cited your site, and the three sites cited most.
            </p>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead className={thead}>
                  <tr>
                    <th className="px-4 py-2 font-medium">Prompt</th>
                    <th className="px-4 py-2 text-right font-medium tabular-nums">Cites You</th>
                    <th className="px-4 py-2 font-medium">Top Cited Sites</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                  {promptRows.map((row) => (
                    <tr key={row.text} className="bg-white dark:bg-zinc-950">
                      <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{row.text}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
                        {row.summary.answersCitingOwnSite} of {row.summary.answers}
                      </td>
                      <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                        {row.summary.sites.length === 0
                          ? "No sources cited"
                          : row.summary.sites
                              .slice(0, 3)
                              .map((s) => s.domain)
                              .join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
