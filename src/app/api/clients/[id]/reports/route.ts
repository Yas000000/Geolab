import { generateMonthlyReport, isValidMonth } from "@/lib/monthly-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // DB reads plus ~6 parallel Key Takeaway calls, ~10-20s in practice

/** Generates (or regenerates) one client's monthly report for { month: "YYYY-MM" }. */
export async function POST(request: Request, ctx: RouteContext<"/api/clients/[id]/reports">): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { month?: string };
  if (!body.month || !isValidMonth(body.month)) {
    return Response.json({ error: "Pick a month (YYYY-MM)." }, { status: 400 });
  }
  try {
    const result = await generateMonthlyReport(id, body.month);
    if (result.ok) return Response.json({ id: result.id, month: result.month });
    if (result.reason === "client_not_found") return Response.json({ error: "Client not found." }, { status: 404 });
    return Response.json(
      { error: "Nothing to report for that month: no completed runs and no Google Analytics data." },
      { status: 400 },
    );
  } catch (err) {
    return Response.json(
      { error: "The report couldn't be generated.", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
