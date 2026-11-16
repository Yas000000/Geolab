import { runCrawlCheck } from "@/lib/crawl-check";
import { archivedReply } from "@/lib/client-lifecycle";
import { requireTeam } from "@/lib/viewer";

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
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { id } = await ctx.params;
  const archived = await archivedReply(id);
  if (archived) return archived;
  // Recorded as who started it: the signed-in team member.
  const result = await runCrawlCheck(id, viewer.email, request);
  if (result.ok) return Response.json(result);
  const r = REASON[result.reason];
  return Response.json({ error: r.message, detail: result.error }, { status: r.status });
}
