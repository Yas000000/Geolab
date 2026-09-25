import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { StatusPill } from "@/components/status-pill";

export const dynamic = "force-dynamic";

async function getClients() {
  return prisma.client.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { brands: true, runs: true } },
      runs: { orderBy: { startedAt: "desc" }, take: 1 },
    },
  });
}

export default async function ClientsPage() {
  const clients = await getClients();

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Clients</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {clients.length} client{clients.length === 1 ? "" : "s"} tracked
          </p>
        </header>

        {clients.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            No clients yet — run the pipeline for a brand and it&apos;ll show up here.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Client</th>
                  <th className="px-4 py-2 font-medium tabular-nums">Brands</th>
                  <th className="px-4 py-2 font-medium tabular-nums">Runs</th>
                  <th className="px-4 py-2 font-medium">Last Run</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {clients.map((client) => {
                  const lastRun = client.runs[0];
                  return (
                    <tr key={client.id} className="bg-white dark:bg-zinc-950">
                      <td className="px-4 py-3">
                        <Link
                          href={`/clients/${client.id}`}
                          className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                        >
                          {client.name}
                        </Link>
                        {client.domain && (
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
                            {client.domain}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums">{client._count.brands}</td>
                      <td className="px-4 py-3 tabular-nums">{client._count.runs}</td>
                      <td className="px-4 py-3">
                        {lastRun ? (
                          <div className="flex items-center gap-2">
                            <StatusPill status={lastRun.status} />
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              {lastRun.startedAt.toLocaleDateString()}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-400 dark:text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/clients/${client.id}`}
                          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          View →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
