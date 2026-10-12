import { prisma } from "@/lib/prisma";
import { RunSchedule } from "@/generated/prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  schedule?: keyof typeof RunSchedule;
  ga4PropertyId?: string | null;
  gscSiteUrl?: string | null;
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/clients/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await request.json()) as PatchBody;

  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  if (body.schedule && !(body.schedule in RunSchedule)) {
    return Response.json({ error: "Invalid schedule" }, { status: 400 });
  }

  const updated = await prisma.client.update({
    where: { id },
    data: {
      schedule: body.schedule ? RunSchedule[body.schedule] : undefined,
      ga4PropertyId: body.ga4PropertyId === undefined ? undefined : body.ga4PropertyId || null,
      gscSiteUrl: body.gscSiteUrl === undefined ? undefined : body.gscSiteUrl || null,
    },
  });

  return Response.json({ client: updated });
}
