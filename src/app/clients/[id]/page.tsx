import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StatusPill } from "@/components/status-pill";

export const dynamic = "force-dynamic";

async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    include: {
      brands: { orderBy: [{ isClientBrand: "desc" }, { name: "asc" }] },
      runs: {
        orderBy: { startedAt: "desc" },
        include: {
          promptSet: true,
          _count: { select: { rawResponses: true } },
        },
      },
    },
  });
}

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const client = await getClient(id);
  if (!client) notFound();

  const clientBrand = client.brands.find((b) => b.isClientBrand);
  const competitors = client.brands.filter((b) => !b.isClientBrand);

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Link
          href="/clients"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          ← All clients
        </Link>

        <header className="mt-1 mb-8">
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
            {client.name}
          </h1>
          {client.domain && (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>
          )}
        </header>

        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Schedule &amp; Analytics
          </h2>
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <span className="text-zinc-500 dark:text-zinc-400">Schedule: </span>
                <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  {client.schedule}
                </span>
              </div>
              <div>
                <span className="text-zinc-500 dark:text-zinc-400">GA4 Property: </span>
                <span className="text-zinc-900 dark:text-zinc-100">
                  {client.ga4PropertyId || "Not set"}
                </span>
              </div>
              <div>
                <span className="text-zinc-500 dark:text-zinc-400">GSC Site: </span>
                <span className="text-zinc-900 dark:text-zinc-100">
                  {client.gscSiteUrl || "Not set"}
                </span>
              </div>
            </div>
            <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-600">
              Captured for future automation — no recurring runs are triggered automatically yet.
            </p>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Brands Tracked
          </h2>
          <div className="flex flex-wrap gap-2">
            {clientBrand && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-3 py-1 text-sm font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                {clientBrand.name}
                <span className="rounded bg-blue-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-900 dark:bg-blue-900 dark:text-blue-200">
                  Client
                </span>
              </span>
            )}
            {competitors.map((b) => (
              <span
                key={b.id}
                className="inline-flex items-center rounded-full bg-zinc-100 px-3 py-1 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              >
                {b.name}
              </span>
            ))}
            {client.brands.length === 0 && (
              <span className="text-sm text-zinc-400 dark:text-zinc-600">
                No brands recorded yet.
              </span>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Run History
          </h2>
          {client.runs.length === 0 ? (
            <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
              No runs yet for this client.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">Started</th>
                    <th className="px-4 py-2 font-medium">Prompt Set</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium tabular-nums">Responses</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                  {client.runs.map((run) => (
                    <tr key={run.id} className="bg-white dark:bg-zinc-950">
                      <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                        {run.startedAt.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                        {run.promptSet.label}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill status={run.status} />
                      </td>
                      <td className="px-4 py-3 tabular-nums">{run._count.rawResponses}</td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/runs/${run.id}`}
                          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          View results →
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
    </div>
  );
}
