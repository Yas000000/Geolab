import { runCrawlCheck } from "@/lib/crawl-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // three vendor calls in parallel, ~15-60s in practice

const REASON: Record<string, { message: string; status: number }> = {
  client_not_found: { message: "Client not found.", status: 404 },
  no_domain: { message: "This client has no domain set.", status: 400 },
  failed: { message: "The crawler check didn't complete.", status: 502 },
};

/** Settings page "Check now": runs the AI crawler access check for one client and stores it. */
export async function POST(request: Request, ctx: RouteContext<"/api/clients/[id]/crawl-check">): Promise<Response> {
  const { id } = await ctx.params;
  // Same identity used for every manually triggered action in this app (see /api/clients).
  const result = await runCrawlCheck(id, "william@digitalmarketing.com", request);
  if (result.ok) return Response.json(result);
  const r = REASON[result.reason];
  return Response.json({ error: r.message, detail: result.error }, { status: r.status });
}
