import { prisma } from "@/lib/prisma";
import { findOrCreateBrand } from "@/lib/run-persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  name?: string;
  domain?: string;
}

export async function POST(request: Request, ctx: RouteContext<"/api/clients/[id]/brands">): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await request.json()) as PostBody;
  const name = body.name?.trim();
  if (!name) {
    return Response.json({ error: "Name is required" }, { status: 400 });
  }

  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  const brand = await findOrCreateBrand(id, name, false);
  const domain = body.domain?.trim();
  if (domain) {
    await prisma.brand.update({ where: { id: brand.id }, data: { domain } });
  }

  return Response.json({ brand }, { status: 201 });
}
