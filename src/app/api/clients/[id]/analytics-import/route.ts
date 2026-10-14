import { importHistoryForClient } from "@/lib/analytics-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REASON: Record<string, { message: string; status: number }> = {
  client_not_found: { message: "Client not found.", status: 404 },
  no_properties: { message: "Set a GA4 property or Search Console site first, then save.", status: 400 },
  not_connected: { message: "No Google account is connected -- connect one on the top-level Settings page.", status: 400 },
  auth_expired: { message: "The Google connection has expired -- reconnect it on the top-level Settings page.", status: 401 },
  failed: { message: "Google returned an error while importing.", status: 502 },
};

/** Imports the last ~16 months of GA4/AI-traffic/Search Console data for one client. */
export async function POST(_request: Request, ctx: RouteContext<"/api/clients/[id]/analytics-import">): Promise<Response> {
  const { id } = await ctx.params;
  const result = await importHistoryForClient(id);
  if (result.ok) return Response.json(result);
  const r = REASON[result.reason];
  return Response.json({ error: r.message, detail: result.error }, { status: r.status });
}
