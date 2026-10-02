import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/prisma";

export const GOOGLE_CONNECTION_ID = "default";

export const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

function redirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI!;
}

export function newOAuthClient(): OAuth2Client {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri());
}

export function googleConsentUrl(): string {
  const client = newOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token on every (re)connect, not just the first ever consent
    scope: GOOGLE_OAUTH_SCOPES,
  });
}

/**
 * Loads the singleton GoogleOAuthConnection row and returns a ready-to-use
 * OAuth2Client with credentials set, for reuse across a whole cron
 * invocation's loop over clients (avoids a redundant token-refresh call
 * per property). Returns null -- never throws -- when no connection has
 * been made yet; callers skip gracefully, matching src/lib/scheduled-run.ts's
 * established "skip and log" pattern for recoverable per-run conditions.
 */
export async function getGoogleOAuthClient(): Promise<OAuth2Client | null> {
  const connection = await prisma.googleOAuthConnection.findUnique({ where: { id: GOOGLE_CONNECTION_ID } });
  if (!connection) {
    console.log("[google-oauth] no GoogleOAuthConnection row yet, skipping");
    return null;
  }
  const client = newOAuthClient();
  client.setCredentials({ refresh_token: connection.refreshToken });
  return client;
}

export function isAuthError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /invalid_grant|unauthorized|invalid credentials|401|403/i.test(message);
}
