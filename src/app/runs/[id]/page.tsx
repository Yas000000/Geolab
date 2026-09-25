import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const PLATFORM_LABEL: Record<string, string> = {
  CHATGPT: "ChatGPT",
  CLAUDE: "Claude",
  GEMINI: "Gemini",
  PERPLEXITY: "Perplexity",
};

const CATEGORY_LABEL: Record<string, string> = {
  best_top: "Best / Top",
  comparison: "Comparison",
  who_offers: "Who Offers",
  recommendation_by_audience: "Recommendation by Audience",
  recommendation_by_constraint: "Recommendation by Constraint",
  shortlist_vendor_selection: "Shortlist / Vendor Selection",
  location_based: "Location-Based",
};

async function getRun(id: string) {
  return prisma.run.findUnique({
    where: { id },
    include: {
      client: true,
      promptSet: { include: { prompts: { orderBy: { position: "asc" } } } },
      rawResponses: {
        include: {
          prompt: true,
          parsedResult: { include: { mentions: { include: { brand: true } } } },
        },
      },
    },
  });
}

type RunData = NonNullable<Awaited<ReturnType<typeof getRun>>>;
type RawResponseData = RunData["rawResponses"][number];

function computeStats(rawResponses: RawResponseData[]) {
  const total = rawResponses.length;
  const mentioned = rawResponses.filter((r) => r.parsedResult?.clientBrandMentioned);
  const mentionedCount = mentioned.length;

  const promptIds = new Set(rawResponses.map((r) => r.promptId));
  const promptsWithMention = new Set(
    mentioned.map((r) => r.promptId),
  );

  const visibilityScore = total ? (mentionedCount / total) * 100 : 0;
  const detectionRate = promptIds.size
    ? (promptsWithMention.size / promptIds.size) * 100
    : 0;
  const top3Count = mentioned.filter(
    (r) => r.parsedResult?.clientBrandRank != null && r.parsedResult.clientBrandRank <= 3,
  ).length;
  const top3Rate = mentionedCount ? (top3Count / mentionedCount) * 100 : 0;
  const nonNegativeCount = mentioned.filter(
    (r) => r.parsedResult?.sentiment !== "NEGATIVE",
  ).length;
  const sentimentScore = mentionedCount ? (nonNegativeCount / mentionedCount) * 100 : 0;

  const byPlatform = new Map<
    string,
    { total: number; mentioned: number; ranks: number[] }
  >();
  for (const r of rawResponses) {
    const bucket = byPlatform.get(r.platform) ?? { total: 0, mentioned: 0, ranks: [] };
    bucket.total += 1;
    if (r.parsedResult?.clientBrandMentioned) {
      bucket.mentioned += 1;
      if (r.parsedResult.clientBrandRank != null) bucket.ranks.push(r.parsedResult.clientBrandRank);
    }
    byPlatform.set(r.platform, bucket);
  }

  const brandCounts = new Map<
    string,
    { name: string; isClientBrand: boolean; appearances: number }
  >();
  for (const r of rawResponses) {
    for (const m of r.parsedResult?.mentions ?? []) {
      const key = m.brand?.id ?? `raw:${m.rawLabel.toLowerCase()}`;
      const existing = brandCounts.get(key);
      if (existing) {
        existing.appearances += 1;
      } else {
        brandCounts.set(key, {
          name: m.brand?.name ?? m.rawLabel,
          isClientBrand: m.brand?.isClientBrand ?? false,
          appearances: 1,
        });
      }
    }
  }
  const brandTable = Array.from(brandCounts.values()).sort(
    (a, b) => b.appearances - a.appearances,
  );

  return {
    total,
    mentionedCount,
    visibilityScore,
    detectionRate,
    top3Rate,
    sentimentScore,
    byPlatform,
    brandTable,
  };
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  );
}

function RankBadge({ rank }: { rank: number | null | undefined }) {
  if (rank == null) {
    return (
      <span className="inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-xs font-medium tabular-nums bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
        —
      </span>
    );
  }
  const good = rank <= 3;
  return (
    <span
      className={`inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-xs font-semibold tabular-nums ${
        good
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
      }`}
    >
      #{rank}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    COMPLETE: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    RUNNING: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
    PENDING: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
    FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        styles[status] ?? styles.PENDING
      }`}
    >
      {status}
    </span>
  );
}

function fmtPct(n: number) {
  return `${n.toFixed(0)}%`;
}

function fmtDuration(start: Date, end: Date | null) {
  if (!end) return null;
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const stats = computeStats(run.rawResponses);
  const platforms = Array.from(new Set(run.rawResponses.map((r) => r.platform)));
  const duration = fmtDuration(run.startedAt, run.completedAt);

  const promptGroups = new Map<string, RunData["promptSet"]["prompts"]>();
  for (const p of run.promptSet.prompts) {
    const list = promptGroups.get(p.category ?? "uncategorized") ?? [];
    list.push(p);
    promptGroups.set(p.category ?? "uncategorized", list);
  }

  const cellByPromptPlatform = new Map<string, RawResponseData>();
  for (const r of run.rawResponses) {
    cellByPromptPlatform.set(`${r.promptId}:${r.platform}`, r);
  }

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
              {run.client.name}
            </h1>
            <StatusPill status={run.status} />
          </div>
          <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {run.client.domain && <span>{run.client.domain} · </span>}
            {run.promptSet.label}
          </div>
          <div className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            Started {run.startedAt.toLocaleString()}
            {duration && <> · {duration}</>}
            {run.triggeredBy && <> · triggered by {run.triggeredBy}</>}
          </div>
        </header>

        {run.status === "FAILED" && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            This run failed before results were fully saved. Check the Vercel runtime logs
            for details — failure diagnostics aren&apos;t persisted to the database.
          </div>
        )}

        {run.rawResponses.length > 0 && (
          <>
            <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Visibility Score"
                value={fmtPct(stats.visibilityScore)}
                sub={`${stats.mentionedCount} of ${stats.total} checks`}
              />
              <StatCard label="Detection Rate" value={fmtPct(stats.detectionRate)} sub="prompts with ≥1 mention" />
              <StatCard label="Top-3 Rate" value={fmtPct(stats.top3Rate)} sub="of mentions" />
              <StatCard label="Sentiment Score" value={fmtPct(stats.sentimentScore)} sub="non-negative mentions" />
            </div>

            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Performance by Platform
              </h2>
              <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">Platform</th>
                      <th className="px-4 py-2 font-medium tabular-nums">Mentions</th>
                      <th className="px-4 py-2 font-medium tabular-nums">Mention Rate</th>
                      <th className="px-4 py-2 font-medium tabular-nums">Avg Rank</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    {platforms.map((platform) => {
                      const b = stats.byPlatform.get(platform)!;
                      const avgRank = b.ranks.length
                        ? (b.ranks.reduce((a, c) => a + c, 0) / b.ranks.length).toFixed(1)
                        : "—";
                      return (
                        <tr key={platform} className="bg-white dark:bg-zinc-950">
                          <td className="px-4 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                            {PLATFORM_LABEL[platform] ?? platform}
                          </td>
                          <td className="px-4 py-2 tabular-nums">
                            {b.mentioned} / {b.total}
                          </td>
                          <td className="px-4 py-2 tabular-nums">{fmtPct((b.mentioned / b.total) * 100)}</td>
                          <td className="px-4 py-2 tabular-nums">{avgRank}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {stats.brandTable.length > 0 && (
              <section className="mb-8">
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Brand Visibility Comparison
                </h2>
                <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                      <tr>
                        <th className="px-4 py-2 font-medium">Brand</th>
                        <th className="px-4 py-2 font-medium tabular-nums">Appearances</th>
                        <th className="px-4 py-2 font-medium tabular-nums">Share of Voice</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                      {stats.brandTable.slice(0, 15).map((b) => (
                        <tr
                          key={b.name}
                          className={
                            b.isClientBrand
                              ? "bg-blue-50 dark:bg-blue-950/40"
                              : "bg-white dark:bg-zinc-950"
                          }
                        >
                          <td className="px-4 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                            {b.name}
                            {b.isClientBrand && (
                              <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                                Client
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 tabular-nums">{b.appearances}</td>
                          <td className="px-4 py-2 tabular-nums">
                            {fmtPct((b.appearances / stats.total) * 100)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Prompt-by-Prompt Results
              </h2>
              <div className="space-y-6">
                {Array.from(promptGroups.entries()).map(([category, prompts]) => (
                  <div key={category}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                      {CATEGORY_LABEL[category] ?? category}
                    </h3>
                    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                      <table className="w-full text-sm">
                        <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                          <tr>
                            <th className="px-4 py-2 font-medium">Prompt</th>
                            {platforms.map((p) => (
                              <th key={p} className="px-3 py-2 text-center font-medium">
                                {PLATFORM_LABEL[p] ?? p}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                          {prompts.map((prompt) => (
                            <tr key={prompt.id} className="bg-white dark:bg-zinc-950">
                              <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                                {prompt.text}
                              </td>
                              {platforms.map((platform) => {
                                const cell = cellByPromptPlatform.get(`${prompt.id}:${platform}`);
                                return (
                                  <td key={platform} className="px-3 py-2 text-center">
                                    <RankBadge rank={cell?.parsedResult?.clientBrandRank} />
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}

        {run.rawResponses.length === 0 && run.status !== "FAILED" && (
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            {run.status === "RUNNING" || run.status === "PENDING"
              ? "This run is still in progress — refresh in a bit."
              : "No results found for this run."}
          </div>
        )}
      </div>
    </div>
  );
}
