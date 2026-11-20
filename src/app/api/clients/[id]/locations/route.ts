import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTeam } from "@/lib/viewer";
import { cleanLocation, type LocationInput } from "@/lib/client-locations";
import { getTrackedPromptSet, saveTrackedPrompts } from "@/lib/tracked-prompts";
import { importCountryHistoryForClient } from "@/lib/analytics-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long enough for the after() import of the new country's Google Analytics history.
export const maxDuration = 800;

/**
 * Settings > Locations: adds a place the client is tracked in. With
 * trackAllPrompts, every tracked prompt gets it too (saved as a new prompt
 * list, like an edit in Tracked Prompts); otherwise prompts are ticked one by one.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/clients/[id]/locations">): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as LocationInput & { trackAllPrompts?: boolean };

  const client = await prisma.client.findUnique({ where: { id }, select: { name: true } });
  if (!client) return Response.json({ error: "Client not found." }, { status: 404 });
  const loc = cleanLocation(body);
  if (typeof loc === "string") return Response.json({ error: loc }, { status: 400 });
  if (await prisma.clientLocation.findFirst({ where: { clientId: id, label: { equals: loc.label, mode: "insensitive" } } })) {
    return Response.json({ error: `${client.name} already has a location called "${loc.label}".` }, { status: 400 });
  }
  const last = await prisma.clientLocation.findFirst({ where: { clientId: id }, orderBy: { position: "desc" } });
  const location = await prisma.clientLocation.create({ data: { clientId: id, ...loc, position: (last?.position ?? 0) + 1 } });

  if (body.trackAllPrompts) {
    const tracked = await getTrackedPromptSet(id);
    if (tracked?.prompts.length) {
      await saveTrackedPrompts(
        id,
        `${client.name} — every prompt tracked in ${location.label} ${new Date().toISOString()}`,
        tracked.prompts.map((p) => ({ category: p.category, text: p.text, locationIds: [...new Set([...(p.locationIds ?? []), location.id])] })),
      );
    }
  }
  // Its country's traffic history for the Traffic tab (a country another location already has is just re-pulled).
  after(importCountryHistoryForClient(id));
  return Response.json({ location }, { status: 201 });
}
