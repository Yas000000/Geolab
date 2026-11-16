import { redirect } from "next/navigation";
import { getViewer } from "@/lib/viewer";

// GEO Rankings is the default landing page for a client -- see
// client-nav.tsx / client-switcher.tsx for the sub-pages this used to be
// a single page for (rankings, traffic, competitors, settings). A client
// login lands on the first tab it's allowed instead.
export default async function ClientRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.role === "TEAM") redirect(`/clients/${id}/rankings`);
  const first = viewer.allowedTabs[0];
  if (first) redirect(`/clients/${id}/${first}`);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
      Nothing has been shared with this login yet. Please check back soon, or contact your account team.
    </div>
  );
}
