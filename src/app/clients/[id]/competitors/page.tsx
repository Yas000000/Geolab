import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { CompetitorManager } from "@/components/competitor-manager";

export const dynamic = "force-dynamic";

async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      domain: true,
      brands: { orderBy: [{ isClientBrand: "desc" }, { name: "asc" }] },
    },
  });
}

export default async function ClientCompetitorsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await getClient(id);
  if (!client) notFound();

  const ownBrand = client.brands.find((b) => b.isClientBrand);
  const competitors = client.brands.filter((b) => !b.isClientBrand);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}</h1>
        {client.domain && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>}
      </header>

      {ownBrand && (
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm dark:border-blue-900 dark:bg-blue-950/40">
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-900 dark:text-blue-200">
            You
          </span>
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{ownBrand.name}</span>
          {ownBrand.domain && <span className="text-zinc-500 dark:text-zinc-400">{ownBrand.domain}</span>}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Competitors
        </h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          Feeds the Competitors table on{" "}
          <a href={`/clients/${id}/rankings`} className="underline">
            GEO Rankings
          </a>
          . Competitors are also detected automatically from run results — add one here only if it should be
          tracked even before it shows up in a response.
        </p>
        <CompetitorManager
          clientId={id}
          initialCompetitors={competitors.map((c) => ({ id: c.id, name: c.name, domain: c.domain }))}
        />
      </section>
    </div>
  );
}
