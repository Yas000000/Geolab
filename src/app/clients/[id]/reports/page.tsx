import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { GenerateReportForm } from "@/components/generate-report-form";
import { lastCompleteMonth, monthLabel, monthsWithRuns } from "@/lib/monthly-report";

export const dynamic = "force-dynamic";

export default async function ClientReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      name: true,
      domain: true,
      monthlyReports: { orderBy: { month: "desc" }, select: { id: true, month: true, updatedAt: true } },
    },
  });
  if (!client) notFound();

  // Offer every month with GEO runs, plus the last full month even if it has none yet.
  const defaultMonth = lastCompleteMonth();
  const months = [...new Set([defaultMonth, ...(await monthsWithRuns(id))])].sort().reverse();

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}</h1>
        {client.domain && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>}
      </header>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Monthly Report
        </h2>
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950">
          <GenerateReportForm
            clientId={id}
            months={months.map((m) => ({ value: m, label: monthLabel(m) }))}
            defaultMonth={defaultMonth}
            existingMonths={client.monthlyReports.map((r) => r.month)}
          />
        </div>
      </section>

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
                  <th className="px-4 py-2 font-medium">Month</th>
                  <th className="px-4 py-2 font-medium">Generated</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {client.monthlyReports.map((r) => (
                  <tr key={r.id} className="bg-white dark:bg-zinc-950">
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">{monthLabel(r.month)}</td>
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
