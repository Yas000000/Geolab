import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { CompetitorManager } from "@/components/competitor-manager";
import { requireTab } from "@/lib/viewer";

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
  const viewer = await requireTab(id, "competitors");
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
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <span className="rounded bg-brand px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            You
          </span>
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{ownBrand.name}</span>
          {ownBrand.domain && <span className="text-zinc-500 dark:text-zinc-400">{ownBrand.domain}</span>}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-text dark:text-red-400">
          Competitors
        </h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          Feeds the Competitors table on{" "}
          <a href={`/clients/${id}/rankings`} className="underline">
            GEO Rankings
          </a>
          .{" "}
          {viewer.role === "TEAM"
            ? "Competitors are also detected automatically from run results — add one here only if it should be tracked even before it shows up in a response."
            : "Competitors are picked up automatically from the brands AI answers name alongside yours."}
        </p>
        <CompetitorManager
          clientId={id}
          initialCompetitors={competitors.map((c) => ({ id: c.id, name: c.name, domain: c.domain }))}
          readOnly={viewer.role !== "TEAM"}
        />
      </section>
    </div>
  );
}
