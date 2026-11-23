import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { requireTeamPage } from "@/lib/viewer";
import { CLIENT_TABS, cleanTabs } from "@/lib/auth";
import { LocalTime, TeamAccess } from "@/components/access";
import { PAGE_WIDTH } from "@/lib/page-width";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Access · GEO Reporting Portal" };

const TAB_LABEL = new Map<string, string>(CLIENT_TABS.map((t) => [t.segment, t.label]));

export default async function AccessPage() {
  const viewer = await requireTeamPage();
  const [team, clients] = await Promise.all([
    prisma.user.findMany({
      where: { role: "TEAM" },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, email: true, lastLoginAt: true, disabledAt: true, mustChangePassword: true },
    }),
    prisma.client.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        archivedAt: true,
        login: { select: { email: true, allowedTabs: true, disabledAt: true, lastLoginAt: true } },
      },
    }),
  ]);
  const h2 = "mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className={`mx-auto ${PAGE_WIDTH} px-4 py-6 sm:px-6 md:py-10`}>
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Access</h1>
        <p className="mb-8 mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Who can sign in to the portal. Team logins see every client and can run everything. A client login sees only
          its own client&apos;s tabs that you turn on.
        </p>

        <section className="mb-10">
          <h2 className={h2}>Team</h2>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            A new team member gets a generated password and chooses their own the first time they sign in.
          </p>
          <TeamAccess
            viewerId={viewer.id}
            members={team.map((m) => ({
              id: m.id,
              name: m.name,
              email: m.email,
              lastLoginAt: m.lastLoginAt?.toISOString() ?? null,
              disabled: Boolean(m.disabledAt),
              mustChangePassword: m.mustChangePassword,
            }))}
          />
        </section>

        <section>
          <h2 className={h2}>Client logins</h2>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">One shared login per client.</p>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Client</th>
                  <th className="px-4 py-2 font-medium">Login</th>
                  <th className="px-4 py-2 font-medium">Tabs they see</th>
                  <th className="px-4 py-2 font-medium">Last signed in</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {clients.map((c) => {
                  const tabs = c.login ? cleanTabs(c.login.allowedTabs) : [];
                  return (
                    <tr key={c.id} className="bg-white dark:bg-zinc-950">
                      <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                        {c.name}
                        {c.archivedAt && <span className="ml-1 text-xs font-normal text-zinc-500">(archived)</span>}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                        {c.login ? (
                          <>
                            {c.login.email}
                            {c.login.disabledAt && <span className="ml-1 text-xs text-red-600 dark:text-red-400">(off)</span>}
                          </>
                        ) : (
                          <span className="text-zinc-400 dark:text-zinc-600">No login</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                        {c.login ? (tabs.length ? tabs.map((t) => TAB_LABEL.get(t)).join(", ") : "None yet") : "—"}
                      </td>
                      <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                        {c.login ? <LocalTime iso={c.login.lastLoginAt?.toISOString() ?? null} /> : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/access/clients/${c.id}`}
                          className="whitespace-nowrap text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {c.login ? "Manage →" : "Set up access →"}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
