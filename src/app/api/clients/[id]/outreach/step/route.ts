import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { runOutreachStep } from "@/lib/outreach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * The next step of an Outreach Plan build that is already RUNNING, in a fresh invocation
 * (src/lib/outreach.ts hands a build here when one invocation's time runs short). It only
 * continues a build someone started from the tab; for any other plan it does nothing.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/clients/[id]/outreach/step">): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { planId?: string };
  if (!body.planId) return Response.json({ error: "planId required." }, { status: 400 });
  const planId = body.planId;
  const plan = await prisma.outreachPlan.findUnique({ where: { id: planId }, select: { clientId: true, status: true } });
  if (!plan || plan.clientId !== id || plan.status !== "RUNNING") {
    return Response.json({ error: "No running build with that id for this client." }, { status: 404 });
  }
  const origin = new URL(request.url).origin;
  after(() => runOutreachStep(planId, origin));
  return Response.json({ ok: true }, { status: 202 });
}
