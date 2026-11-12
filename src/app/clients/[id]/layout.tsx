import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ClientSwitcher } from "@/components/client-switcher";
import { ClientNav } from "@/components/client-nav";

export const dynamic = "force-dynamic";

async function getClientList() {
  return prisma.client.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

export default async function ClientLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  const clients = await getClientList();
  if (!clients.some((c) => c.id === id)) notFound();

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className="border-b border-zinc-200 bg-white px-4 py-2.5 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex max-w-6xl items-center gap-4">
          <ClientSwitcher clients={clients} currentId={id} />
          <Link
            href="/clients"
            className="shrink-0 whitespace-nowrap text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            All clients
          </Link>
        </div>
      </div>
      {/* Below md the sidebar becomes a swipeable tab row above the content,
          so a phone gets the full width instead of ~120px beside a 176px menu. */}
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row md:gap-8 md:py-10">
        <ClientNav clientId={id} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
