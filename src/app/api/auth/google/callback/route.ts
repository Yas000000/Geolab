import { prisma } from "@/lib/prisma";
import { newOAuthClient, GOOGLE_CONNECTION_ID } from "@/lib/google-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const code = new URL(request.url).searchParams.get("code");
  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    // Google only issues a refresh_token on first consent or when
    // prompt=consent forces re-issuance (set in googleConsentUrl) -- if
    // this is ever missing, the consent step itself didn't go through
    // the expected path, so fail loudly rather than silently keeping a
    // stale/absent token.
    return new Response(
      "Google did not return a refresh token. Try the connect flow again.",
      { status: 502 },
    );
  }

  let connectedEmail = "unknown";
  if (tokens.id_token) {
    try {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
      connectedEmail = ticket.getPayload()?.email ?? "unknown";
    } catch (err) {
      console.log(`[google-oauth] could not decode id_token email: ${err instanceof Error ? err.message : err}`);
    }
  }

  await prisma.googleOAuthConnection.upsert({
    where: { id: GOOGLE_CONNECTION_ID },
    create: {
      id: GOOGLE_CONNECTION_ID,
      connectedEmail,
      refreshToken: tokens.refresh_token,
      lastVerifiedAt: new Date(),
    },
    update: {
      connectedEmail,
      refreshToken: tokens.refresh_token,
      lastVerifiedAt: new Date(),
      lastError: null,
    },
  });

  return Response.redirect(new URL("/settings", request.url));
}
