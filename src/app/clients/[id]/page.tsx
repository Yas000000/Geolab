import { redirect } from "next/navigation";

// GEO Rankings is the default landing page for a client -- see
// client-nav.tsx / client-switcher.tsx for the sub-pages this used to be
// a single page for (rankings, traffic, competitors, settings).
export default async function ClientRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/clients/${id}/rankings`);
}
