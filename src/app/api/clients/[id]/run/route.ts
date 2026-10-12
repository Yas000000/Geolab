import { runClientNow } from "@/lib/scheduled-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REASON_MESSAGE: Record<string, string> = {
  already_running: "This client already has a run in progress.",
  no_brand: "No tracked brand found for this client.",
  client_not_found: "Client not found.",
  no_domain: "This client has no domain set -- add one in Settings first.",
  no_prompts: "No prior prompts found to reuse -- this client has never completed a run.",
};

export async function POST(_request: Request, ctx: RouteContext<"/api/clients/[id]/run">): Promise<Response> {
  const { id } = await ctx.params;

  // "william@digitalmarketing.com" matches the identity used elsewhere in
  // this app for manually-triggered runs (see /api/clients, /api/runs).
  const result = await runClientNow(id, "william@digitalmarketing.com");

  if (result.ok) {
    return Response.json({ runId: result.runId, status: "COMPLETE" });
  }
  if (result.reason === "pipeline_failed") {
    return Response.json({ runId: result.runId, status: "FAILED", error: result.error }, { status: 502 });
  }
  return Response.json(
    { error: REASON_MESSAGE[result.reason] ?? result.reason },
    { status: result.reason === "client_not_found" ? 404 : 400 },
  );
}
