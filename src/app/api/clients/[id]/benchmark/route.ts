import { prisma } from "@/lib/prisma";
import { importBenchmarkSnapshot, type BenchmarkImportPayload } from "@/lib/benchmark-import";
import { requireTeam } from "@/lib/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: RouteContext<"/api/clients/[id]/benchmark">): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { id } = await ctx.params;
  const body = (await request.json()) as BenchmarkImportPayload;

  if (!body.source || !body.snapshotDate) {
    return Response.json({ error: "source and snapshotDate are required" }, { status: 400 });
  }

  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  const snapshot = await importBenchmarkSnapshot(id, body);
  return Response.json({ snapshot }, { status: 201 });
}
