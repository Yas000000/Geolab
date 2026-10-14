import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StatusPill } from "@/components/status-pill";
import { ClientSettingsForm } from "@/components/client-settings-form";
import { RunNowButton } from "@/components/run-now-button";
import { TrackedPromptsEditor } from "@/components/tracked-prompts-editor";
import { getTrackedPromptSet } from "@/lib/tracked-prompts";
import { formatPromptsText } from "@/lib/parse-prompts";

export const dynamic = "force-dynamic";

async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      domain: true,
      schedule: true,
      ga4PropertyId: true,
      gscSiteUrl: true,
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

export default async function ClientSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await getClient(id);
  if (!client) notFound();
  const trackedPromptSet = await getTrackedPromptSet(id);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}</h1>
        {client.domain && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>}
      </header>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Run Now
        </h2>
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950">
          <RunNowButton clientId={id} />
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Tracked Prompts
        </h2>
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950">
          <TrackedPromptsEditor clientId={id} initialText={formatPromptsText(trackedPromptSet?.prompts ?? [])} />
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Scheduling &amp; Integrations
        </h2>
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950">
          <ClientSettingsForm
            clientId={id}
            initialSchedule={client.schedule}
            initialGa4PropertyId={client.ga4PropertyId ?? ""}
            initialGscSiteUrl={client.gscSiteUrl ?? ""}
          />
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
                    <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{run.startedAt.toLocaleString()}</td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{run.promptSet.label}</td>
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
  );
}
