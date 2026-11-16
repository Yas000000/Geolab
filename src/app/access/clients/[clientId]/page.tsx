import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { requireTeamPage } from "@/lib/viewer";
import { CLIENT_TABS, cleanTabs } from "@/lib/auth";
import { ClientAccessEditor } from "@/components/access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Client access · GEO Reporting Portal" };

// Tabs ticked when a client's login is first set up; the team can change them before creating it.
const DEFAULT_TABS = ["traffic", "rankings", "citations", "reports"];

export default async function ClientAccessPage({ params }: PageProps<"/access/clients/[clientId]">) {
  await requireTeamPage();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      login: { select: { id: true, email: true, allowedTabs: true, disabledAt: true, lastLoginAt: true } },
    },
  });
  if (!client) notFound();

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 md:py-10">
        <Link href="/access" className="text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
          ← Access
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}: client access</h1>
        <p className="mb-6 mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {client.login
            ? "Change what this client's login can see, reset its password or turn it off."
            : `Set up the login ${client.name} uses to see their own reports in the portal.`}
        </p>
        <section className="rounded-lg border border-zinc-200 bg-white px-4 py-5 dark:border-zinc-800 dark:bg-zinc-950">
          <ClientAccessEditor
            client={{ id: client.id, name: client.name, archived: Boolean(client.archivedAt) }}
            login={
              client.login
                ? {
                    id: client.login.id,
                    email: client.login.email,
                    allowedTabs: cleanTabs(client.login.allowedTabs),
                    disabled: Boolean(client.login.disabledAt),
                    lastLoginAt: client.login.lastLoginAt?.toISOString() ?? null,
                  }
                : null
            }
            tabs={CLIENT_TABS.map((t) => ({ segment: t.segment, label: t.label }))}
            defaultTabs={DEFAULT_TABS}
          />
        </section>
      </div>
    </div>
  );
}
