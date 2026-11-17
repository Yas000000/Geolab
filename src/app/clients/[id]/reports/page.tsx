import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { GenerateReportForm, type CompareOption } from "@/components/generate-report-form";
import { compareChoices, defaultCompare } from "@/lib/monthly-report";
import { lastFullMonth, periodLabel, periodPresets } from "@/lib/report-period";
import { requireTab } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function ClientReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireTab(id, "reports");
  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      name: true,
      domain: true,
      monthlyReports: {
        orderBy: [{ periodEnd: "desc" }, { periodStart: "desc" }],
        select: { id: true, periodStart: true, periodEnd: true, compareLabel: true, updatedAt: true },
      },
    },
  });
  if (!client) notFound();

  // Default: the last full month against the client's first imported
  // benchmark, else its first crawl, else the month before.
  // (Team only: a client login sees the saved reports, not the Generate form.)
  const isTeam = viewer.role === "TEAM";
  let form: React.ReactNode = null;
  if (isTeam) {
    const choices = await compareChoices(id);
    const fallback = defaultCompare(choices);
    const options: CompareOption[] = [
      ...choices.benchmarks.map((b) => ({ value: `benchmark:${b.id}`, label: b.label })),
      ...(choices.firstCrawl ? [{ value: "firstCrawl", label: choices.firstCrawl.label }] : []),
      { value: "previous", label: "Previous period" },
      { value: "custom", label: "Custom range…" },
    ];
    form = (
      <GenerateReportForm
        clientId={id}
        presets={periodPresets()}
        defaultPeriod={lastFullMonth()}
        compareOptions={options}
        defaultCompare={fallback.kind === "benchmark" ? `benchmark:${fallback.snapshotId}` : fallback.kind}
        firstCrawlDays={choices.firstCrawl?.days ?? null}
        savedPeriods={client.monthlyReports.map((r) => ({ start: r.periodStart, end: r.periodEnd }))}
      />
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}</h1>
        {client.domain && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>}
      </header>

      {form && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Generate a Report
          </h2>
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950">{form}</div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Saved Reports
        </h2>
        {client.monthlyReports.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            No reports yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Period</th>
                  <th className="px-4 py-2 font-medium">Compared with</th>
                  <th className="px-4 py-2 font-medium">Generated</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {client.monthlyReports.map((r) => (
                  <tr key={r.id} className="bg-white dark:bg-zinc-950">
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">{periodLabel(r.periodStart, r.periodEnd)}</td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{r.compareLabel || "n/a"}</td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                      {r.updatedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/report/${r.id}`} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
                        Open report →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
