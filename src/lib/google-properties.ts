import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export interface Ga4PropertyOption {
  propertyId: string;
  displayName: string;
  accountDisplayName: string;
}

export interface GscSiteOption {
  siteUrl: string;
  permissionLevel: string;
}

function parsePropertyId(resourceName: string | null | undefined): string | null {
  if (!resourceName) return null;
  const parts = resourceName.split("/");
  return parts[parts.length - 1] || null;
}

/**
 * Every GA4 property the connected account can access, across every
 * account, in one paginated listing -- accountSummaries.list nests
 * propertySummaries per account, so this is a single call shape (plus
 * pagination) rather than a per-account properties.list loop. Covered by
 * the already-granted analytics.readonly scope, no new consent needed.
 */
export async function listGa4Properties(authClient: OAuth2Client): Promise<Ga4PropertyOption[]> {
  const analyticsAdmin = google.analyticsadmin({ version: "v1beta", auth: authClient });
  const options: Ga4PropertyOption[] = [];
  let pageToken: string | undefined;

  do {
    const res = await analyticsAdmin.accountSummaries.list({ pageSize: 200, pageToken });
    for (const account of res.data.accountSummaries ?? []) {
      for (const property of account.propertySummaries ?? []) {
        const propertyId = parsePropertyId(property.property);
        if (!propertyId) continue;
        options.push({
          propertyId,
          displayName: property.displayName ?? propertyId,
          accountDisplayName: account.displayName ?? "",
        });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return options;
}

/** Every Search Console site the connected account can access. Covered by
 * the already-granted webmasters.readonly scope. */
export async function listGscSites(authClient: OAuth2Client): Promise<GscSiteOption[]> {
  const searchconsole = google.searchconsole({ version: "v1", auth: authClient });
  const res = await searchconsole.sites.list();
  return (res.data.siteEntry ?? []).map((s) => ({
    siteUrl: s.siteUrl ?? "",
    permissionLevel: s.permissionLevel ?? "",
  }));
}
