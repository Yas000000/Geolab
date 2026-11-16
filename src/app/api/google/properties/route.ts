import { getGoogleOAuthClient } from "@/lib/google-oauth";
import { listGa4Properties, listGscSites } from "@/lib/google-properties";
import { requireTeam } from "@/lib/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const client = await getGoogleOAuthClient();
  if (!client) {
    return Response.json({ connected: false, ga4: [], gsc: [] });
  }

  try {
    const [ga4, gsc] = await Promise.all([listGa4Properties(client), listGscSites(client)]);
    return Response.json({ connected: true, ga4, gsc });
  } catch (err) {
    console.log(`[api/google/properties] listing failed: ${err instanceof Error ? err.message : err}`);
    return Response.json({ connected: false, ga4: [], gsc: [] });
  }
}
