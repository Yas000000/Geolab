import { prisma } from "@/lib/prisma";

/**
 * A client's locations (MacuMira: Canada, Australia, New Zealand), in the
 * shape the Python pipeline takes. Live Search asks each prompt once per
 * location in its locationIds, as if searching from there; Training Search
 * ignores them (see ClientLocation in schema.prisma).
 */
export async function pipelineLocations(clientId: string) {
  const rows = await prisma.clientLocation.findMany({ where: { clientId }, orderBy: { position: "asc" } });
  return rows.map((l) => ({ id: l.id, label: l.label, country: l.country, region: l.region, city: l.city }));
}

/** ISO 3166-1 alpha-2, as the engines' location settings take it. */
export const isCountryCode = (s: string) => /^[A-Z]{2}$/.test(s);

/** "Canada" for "CA" (falls back to the code when the runtime has no name for it). */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface LocationInput {
  label?: string;
  country: string;
  region?: string | null;
  city?: string | null;
}

/** Cleans one location from a form: upper-case country code, label defaulting to "City, Country". */
export function cleanLocation(l: LocationInput): { label: string; country: string; region: string | null; city: string | null } | string {
  const country = (l.country ?? "").trim().toUpperCase();
  if (!isCountryCode(country)) return `"${l.country}" isn't a two-letter country code (for example CA, AU or NZ).`;
  const city = l.city?.trim() || null;
  const region = l.region?.trim() || null;
  const label = l.label?.trim() || [city, countryName(country)].filter(Boolean).join(", ");
  return { label, country, region, city };
}

/**
 * How many questions one Live Search asks per platform: each prompt once per
 * location it's tracked in, or once if it has none. Run time and cost scale
 * with this, not the prompt count.
 */
export function liveAsks(prompts: { locationIds?: string[] | null }[], locationIds: Set<string>): number {
  return prompts.reduce((n, p) => n + Math.max(1, (p.locationIds ?? []).filter((id) => locationIds.has(id)).length), 0);
}
