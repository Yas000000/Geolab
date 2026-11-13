import { after } from "next/server";
import { latestOutreachPlans, runOutreachStep, startOutreachBuild } from "@/lib/outreach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The build's first step runs in after() once the reply is sent, inside this route's time
// limit; later steps run in /outreach/step (see src/lib/outreach.ts).
export const maxDuration = 800;

const REASON: Record<string, { message: string; status: number }> = {
  client_not_found: { message: "Client not found.", status: 404 },
  no_domain: { message: "This client has no domain set. Add it in Settings first.", status: 400 },
  no_crawl: { message: "No Live Search crawl with citations yet. Run a Live Search from Settings first.", status: 400 },
  running: { message: "A build is already running for this client.", status: 409 },
};

/** The latest build's status, for the Outreach Plan tab to poll while one runs. */
export async function GET(_request: Request, ctx: RouteContext<"/api/clients/[id]/outreach">): Promise<Response> {
  const { id } = await ctx.params;
  const { latest } = await latestOutreachPlans(id);
  return Response.json(latest ?? null);
}

/**
 * Outreach Plan tab "Build" / "Rebuild": starts a paid build from the latest Live Search crawl.
 * Only ever called from that button, after the cost was shown and confirmed.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/clients/[id]/outreach">): Promise<Response> {
  const { id } = await ctx.params;
  // Same identity used for every manually triggered action in this app (see /api/clients).
  const started = await startOutreachBuild(id, "william@digitalmarketing.com");
  if (!started.ok) {
    const r = REASON[started.reason];
    return Response.json({ error: r.message }, { status: r.status });
  }
  const origin = new URL(request.url).origin;
  after(() => runOutreachStep(started.planId, origin));
  return Response.json({ planId: started.planId }, { status: 202 });
}
