import { googleConsentUrl } from "@/lib/google-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.redirect(googleConsentUrl());
}
