import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ClientSwitcher } from "@/components/client-switcher";
import { ClientNav } from "@/components/client-nav";
import { ArchivedBanner } from "@/components/client-lifecycle";
import { PageFrame } from "@/components/page-frame";
import { getViewer } from "@/lib/viewer";
import { homePath } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function getClientList() {
  return prisma.client.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, archivedAt: true },
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
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  // A client login only ever sees its own client (each tab page checks the tab too).
  if (viewer.role === "CLIENT" && viewer.clientId !== id) redirect(homePath(viewer));
  const isTeam = viewer.role === "TEAM";

  const clients = await getClientList();
  const current = clients.find((c) => c.id === id);
  if (!current) notFound();
  // The switcher lists active clients only, plus this one when it's archived.
  const switcherClients = clients
    .filter((c) => !c.archivedAt || c.id === id)
    .map((c) => ({ id: c.id, name: c.archivedAt ? `${c.name} (archived)` : c.name }));

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className="border-b border-zinc-200 bg-white px-4 py-2.5 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950">
        <PageFrame className="flex items-center gap-4">
          {isTeam ? (
            <>
              <ClientSwitcher clients={switcherClients} currentId={id} />
              <Link
                href="/clients"
                className="shrink-0 whitespace-nowrap text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                All clients
              </Link>
            </>
          ) : (
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{current.name}</span>
          )}
        </PageFrame>
      </div>
      {/* Below md the sidebar becomes a swipeable tab row above the content,
          so a phone gets the full width instead of ~120px beside a 176px menu. */}
      <PageFrame className="flex flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row md:gap-8 md:py-10">
        <ClientNav clientId={id} tabs={isTeam ? null : viewer.allowedTabs} />
        <div className="min-w-0 flex-1">
          {isTeam && current.archivedAt && (
            <ArchivedBanner clientId={id} name={current.name} archivedAt={current.archivedAt.toISOString()} />
          )}
          {children}
        </div>
      </PageFrame>
    </div>
  );
}
