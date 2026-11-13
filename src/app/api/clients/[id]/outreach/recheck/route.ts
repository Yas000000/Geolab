import { applyRecheck } from "@/lib/outreach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // the plan is recomputed in the Python function, ~10-20s, no paid calls

const REASON: Record<string, { message: string; status: number }> = {
  client_not_found: { message: "Client not found.", status: 404 },
  no_plan: { message: "Build an outreach plan first.", status: 400 },
  running: { message: "A build is running for this client. Re-check once it finishes.", status: 409 },
};

/**
 * Outreach Plan tab "Re-check blocked pages": the results the Outreach Helper read in Chrome on
 * the user's PC ({ checks: { site: { url: check } } }), saved into the client's latest plan.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/clients/[id]/outreach/recheck">): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { checks?: unknown } | null;
  if (!body?.checks || typeof body.checks !== "object") {
    return Response.json({ error: "Expected { checks: { site: { url: check } } }." }, { status: 400 });
  }
  try {
    const result = await applyRecheck(id, body.checks as Record<string, Record<string, Record<string, unknown>>>, new URL(request.url).origin);
    if (result.ok) return Response.json(result);
    const r = REASON[result.reason];
    return Response.json({ error: r.message }, { status: r.status });
  } catch (err) {
    return Response.json(
      { error: "The re-check couldn't be saved.", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
