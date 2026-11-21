import { prisma } from "@/lib/prisma";
import { requireTeam } from "@/lib/viewer";
import { cleanLocation, type LocationInput } from "@/lib/client-locations";
import { getTrackedPromptSet, saveTrackedPrompts } from "@/lib/tracked-prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/clients/[id]/locations/[locationId]">;

/** Settings > Locations: renames a location or changes where it searches from. Its answers stay its own. */
export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { id, locationId } = await ctx.params;
  const existing = await prisma.clientLocation.findFirst({ where: { id: locationId, clientId: id } });
  if (!existing) return Response.json({ error: "Location not found." }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as Partial<LocationInput>;
  const loc = cleanLocation({
    label: body.label ?? existing.label,
    country: body.country ?? existing.country,
    region: body.region === undefined ? existing.region : body.region,
    city: body.city === undefined ? existing.city : body.city,
  });
  if (typeof loc === "string") return Response.json({ error: loc }, { status: 400 });
  const clash = await prisma.clientLocation.findFirst({
    where: { clientId: id, id: { not: locationId }, label: { equals: loc.label, mode: "insensitive" } },
  });
  if (clash) return Response.json({ error: `There's already a location called "${loc.label}".` }, { status: 400 });
  const location = await prisma.clientLocation.update({ where: { id: locationId }, data: loc });
  return Response.json({ location });
}

/**
 * Settings > Locations: removes a location no answer has come from yet (and
 * takes it off every tracked prompt). Once it has answers it stays, so its
 * history keeps its place: untick it on the prompts to stop tracking there.
 */
export async function DELETE(_request: Request, ctx: Ctx): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { id, locationId } = await ctx.params;
  const existing = await prisma.clientLocation.findFirst({ where: { id: locationId, clientId: id }, include: { client: { select: { name: true } } } });
  if (!existing) return Response.json({ error: "Location not found." }, { status: 404 });
  const answers = await prisma.rawResponse.count({ where: { locationId } });
  if (answers > 0) {
    return Response.json(
      { error: `${existing.label} already has ${answers} answers, so it can't be removed. Untick it on the prompts in Tracked Prompts to stop tracking there.` },
      { status: 409 },
    );
  }
  const tracked = await getTrackedPromptSet(id);
  if (tracked?.prompts.some((p) => p.locationIds?.includes(locationId))) {
    await saveTrackedPrompts(
      id,
      `${existing.client.name} — ${existing.label} removed ${new Date().toISOString()}`,
      tracked.prompts.map((p) => ({ category: p.category, text: p.text, locationIds: (p.locationIds ?? []).filter((x) => x !== locationId) })),
    );
  }
  await prisma.clientLocation.delete({ where: { id: locationId } });
  return Response.json({ ok: true });
}
