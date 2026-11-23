import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { StatusPill } from "@/components/status-pill";
import { LocalDay, RestoreButton } from "@/components/client-lifecycle";
import { requireTeamPage } from "@/lib/viewer";
import { PAGE_WIDTH } from "@/lib/page-width";
import { InfoNote } from "@/components/info-note";

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
  await requireTeamPage();
  const all = await getClients();
  const clients = all.filter((c) => !c.archivedAt);
  const archived = all
    .filter((c) => c.archivedAt)
    .sort((a, b) => (b.archivedAt?.getTime() ?? 0) - (a.archivedAt?.getTime() ?? 0));

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className={`mx-auto ${PAGE_WIDTH} px-4 py-6 sm:px-6 md:py-10`}>
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Clients</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {clients.length} client{clients.length === 1 ? "" : "s"} tracked
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/settings"
              className="text-sm font-medium text-zinc-600 hover:underline dark:text-zinc-400"
            >
              Settings
            </Link>
            <Link
              href="/clients/new"
              className="inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              + Add Client
            </Link>
          </div>
        </header>

        {clients.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            {archived.length > 0
              ? "No active clients. Archived clients are listed below."
              : "No clients yet — run the pipeline for a brand and it'll show up here."}
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
                          href={`/clients/${client.id}/rankings`}
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
                          href={`/clients/${client.id}/rankings`}
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

        {archived.length > 0 && (
          <details className="group mt-8">
            <summary className="cursor-pointer select-none text-sm font-semibold uppercase tracking-wide text-blue-600 hover:text-blue-700 dark:text-blue-500 dark:hover:text-blue-400">
              Archived clients ({archived.length})
            </summary>
            <InfoNote className="mt-2">
              Archived clients keep all their data but don&apos;t run on a schedule. Open one to view its history, or
              restore it here.
            </InfoNote>
            <ul className="mt-3 divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
              {archived.map((client) => (
                <li
                  key={client.id}
                  className="flex flex-wrap items-center justify-between gap-3 bg-white px-4 py-3 text-sm dark:bg-zinc-950"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/clients/${client.id}/rankings`}
                      className="font-medium text-zinc-700 hover:underline dark:text-zinc-300"
                    >
                      {client.name}
                    </Link>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {client.domain ? `${client.domain} · ` : ""}
                      {client._count.runs} run{client._count.runs === 1 ? "" : "s"} · archived{" "}
                      <LocalDay iso={client.archivedAt!.toISOString()} />
                    </div>
                  </div>
                  <RestoreButton clientId={client.id} small />
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
