import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/clients/[id]/brands/[brandId]">,
): Promise<Response> {
  const { id, brandId } = await ctx.params;

  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand || brand.clientId !== id) {
    return Response.json({ error: "Competitor not found" }, { status: 404 });
  }
  if (brand.isClientBrand) {
    return Response.json({ error: "Cannot remove the client's own brand" }, { status: 400 });
  }

  await prisma.brand.delete({ where: { id: brandId } });
  return Response.json({ ok: true });
}
