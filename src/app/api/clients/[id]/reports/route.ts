import { generateMonthlyReport } from "@/lib/monthly-report";
import { makePeriod, parseCompareSpec, periodError } from "@/lib/report-period";
import { archivedReply } from "@/lib/client-lifecycle";
import { requireTeam } from "@/lib/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // DB reads plus ~6 parallel Key Takeaway calls, ~10-20s in practice

/**
 * Generates (or regenerates) one client's report for
 * { start: "YYYY-MM-DD", end: "YYYY-MM-DD", compare: CompareSpec }.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/clients/[id]/reports">): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { id } = await ctx.params;
  const archived = await archivedReply(id);
  if (archived) return archived;
  const body = (await request.json().catch(() => ({}))) as { start?: unknown; end?: unknown; compare?: unknown };
  const bad = periodError(body.start, body.end);
  if (bad) return Response.json({ error: bad }, { status: 400 });
  const compare = parseCompareSpec(body.compare);
  if (!compare) return Response.json({ error: "Pick what to compare with." }, { status: 400 });
  if (compare.kind === "custom") {
    const badCompare = periodError(compare.start, compare.end, "comparison period");
    if (badCompare) return Response.json({ error: badCompare }, { status: 400 });
  }
  try {
    const result = await generateMonthlyReport(id, makePeriod(body.start as string, body.end as string), compare);
    if (result.ok) return Response.json({ id: result.id });
    if (result.reason === "client_not_found") return Response.json({ error: "Client not found." }, { status: 404 });
    if (result.reason === "compare_not_found") {
      return Response.json(
        { error: compare.kind === "benchmark" ? "That benchmark wasn't found for this client." : "This client has no completed crawl yet." },
        { status: 400 },
      );
    }
    return Response.json(
      { error: "Nothing to report for those days: no completed runs and no Google Analytics data." },
      { status: 400 },
    );
  } catch (err) {
    return Response.json(
      { error: "The report couldn't be generated.", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
