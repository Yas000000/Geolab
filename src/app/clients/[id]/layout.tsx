import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ClientSwitcher } from "@/components/client-switcher";

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

  return (
    <div>
      <div className="border-b border-zinc-200 bg-white px-6 py-2.5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex max-w-5xl items-center gap-4">
          <ClientSwitcher clients={clients} currentId={id} />
          <Link
            href="/clients"
            className="text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            All clients
          </Link>
        </div>
      </div>
      {children}
    </div>
  );
}
