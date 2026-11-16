import { googleConsentUrl } from "@/lib/google-oauth";
import { requireTeam } from "@/lib/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  return Response.redirect(googleConsentUrl());
}
