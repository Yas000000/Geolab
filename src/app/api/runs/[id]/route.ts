import { prisma } from "@/lib/prisma";
import { requireTeam } from "@/lib/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/runs/[id]">,
): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { id } = await ctx.params;

  const run = await prisma.run.findUnique({
    where: { id },
    include: {
      client: true,
      promptSet: { include: { prompts: true } },
      rawResponses: { include: { parsedResult: { include: { mentions: true } } } },
    },
  });

  if (!run) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return Response.json(run);
}
