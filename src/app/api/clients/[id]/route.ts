import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { importHistoryForClient } from "@/lib/analytics-sync";
import { RunSchedule } from "@/generated/prisma/client";
import { deleteClient, setArchived } from "@/lib/client-lifecycle";
import { requireTeam } from "@/lib/viewer";
import { cleanOtherNames } from "@/lib/client-names";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long enough for the after() history import a GA4/GSC change triggers.
export const maxDuration = 800;

interface PatchBody {
  schedule?: keyof typeof RunSchedule;
  ga4PropertyId?: string | null;
  gscSiteUrl?: string | null;
  /** Scheduled runs are Live Search (true) or Training Search (false). */
  scheduledLiveSearch?: boolean;
  /** GEO Traffic shows the AI Conversions section. */
  showAiConversions?: boolean;
  /** Settings > Archive or Delete: true archives the client, false restores it. Sent on its own. */
  archived?: boolean;
  /** Settings > Other Names: names AI answers use for the client besides its brand name. */
  otherNames?: string[] | string;
  /** Settings > Other Names: match the brand and other names only exactly (same capitals, whole word). */
  exactNameMatch?: boolean;
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/clients/[id]">): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { id } = await ctx.params;
  const body = (await request.json()) as PatchBody;

  if (typeof body.archived === "boolean") {
    const result = await setArchived(id, body.archived);
    if (!result) return Response.json({ error: "Client not found" }, { status: 404 });
    return Response.json({ archivedAt: result.archivedAt });
  }

  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  if (body.schedule && !(body.schedule in RunSchedule)) {
    return Response.json({ error: "Invalid schedule" }, { status: 400 });
  }
  const otherNames = body.otherNames === undefined ? undefined : cleanOtherNames(body.otherNames, client.name);
  if (typeof otherNames === "string") return Response.json({ error: otherNames }, { status: 400 });

  const updated = await prisma.client.update({
    where: { id },
    data: {
      otherNames,
      exactNameMatch: typeof body.exactNameMatch === "boolean" ? body.exactNameMatch : undefined,
      schedule: body.schedule ? RunSchedule[body.schedule] : undefined,
      ga4PropertyId: body.ga4PropertyId === undefined ? undefined : body.ga4PropertyId || null,
      gscSiteUrl: body.gscSiteUrl === undefined ? undefined : body.gscSiteUrl || null,
      scheduledLiveSearch: typeof body.scheduledLiveSearch === "boolean" ? body.scheduledLiveSearch : undefined,
      showAiConversions: typeof body.showAiConversions === "boolean" ? body.showAiConversions : undefined,
    },
  });

  // A newly set or changed GA4 property / Search Console site gets its
  // history imported right away, after the response -- otherwise the
  // Traffic page only fills in one day per daily pull.
  const analyticsChanged =
    (updated.ga4PropertyId && updated.ga4PropertyId !== client.ga4PropertyId) ||
    (updated.gscSiteUrl && updated.gscSiteUrl !== client.gscSiteUrl);
  if (analyticsChanged) after(importHistoryForClient(id));

  return Response.json({ client: updated, importingHistory: Boolean(analyticsChanged) });
}

/**
 * Settings > Archive or Delete: deletes the client and everything under it, for good.
 * The body must carry { confirmName } matching the client's name (any case).
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/clients/[id]">): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { confirmName?: string };
  const result = await deleteClient(id, body.confirmName ?? "");
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ deleted: result.name });
}
