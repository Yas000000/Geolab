import { prisma } from "@/lib/prisma";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWholeWordSubstring(needle: string, haystack: string): boolean {
  return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(haystack);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

interface CanonicalEntry {
  brandId: string;
  name: string; // original-cased current canonical text for this brand
}

/**
 * Resolves every distinct name extracted from one run's pipeline response to
 * a canonical Brand row for `clientId`, merging whole-word-boundary substring
 * aliases of the same real brand (e.g. "Polarion ALM" / "Siemens Polarion
 * ALM") -- the persistent, cross-run counterpart of
 * geo-proposal-generator/visibility.py's _merge_substring_aliases().
 *
 * Unlike that single-run, in-memory version, the canonical-forms registry
 * here is seeded from every Brand name + BrandAlias text this client has
 * EVER had across all past runs, and matching must be checked in both
 * directions -- a persisted Brand.name from an earlier run has no guarantee
 * of being the shortest form that will ever be seen for that cluster, the
 * way an in-run canonical always is relative to not-yet-processed keys in
 * the source tool.
 *
 * `clientBrandId` is the id of the client's own tracked Brand row (already
 * resolved by the caller). If an extracted name is a substring-alias of the
 * client's own brand, mentions of it still resolve to `clientBrandId`, but
 * this function never rewrites that row's `name` -- the client's own brand
 * name is user-provided ground truth, not an LLM-extraction guess, and
 * shouldn't drift based on text that happened to show up in one AI response.
 *
 * Returns a Map from each input name's lowercased text to the Brand id it
 * resolved to -- same shape as the `brandIdByName` map callPipelineAndPersist
 * already builds.
 */
export async function resolveBrandNames(
  clientId: string,
  names: string[],
  clientBrandId: string,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  const [brands, aliases] = await Promise.all([
    prisma.brand.findMany({ where: { clientId }, select: { id: true, name: true } }),
    prisma.brandAlias.findMany({
      where: { brand: { clientId } },
      select: { brandId: true, alias: true },
    }),
  ]);

  for (const b of brands) resolved.set(b.name.toLowerCase(), b.id);
  for (const a of aliases) resolved.set(a.alias.toLowerCase(), a.brandId);

  // Sorted ascending so DB-seeded canonicals are checked shortest-first,
  // matching the source's "shortest/cleanest label anchors" convention.
  const canonicals: CanonicalEntry[] = brands
    .map((b) => ({ brandId: b.id, name: b.name }))
    .sort((a, b) => a.name.length - b.name.length);

  const uniqueNames = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)));
  uniqueNames.sort((a, b) => a.length - b.length);

  for (const name of uniqueNames) {
    const key = name.toLowerCase();
    if (resolved.has(key)) continue; // already a known exact form (DB, or resolved earlier in this run)

    const match = canonicals.find(
      (c) =>
        isWholeWordSubstring(c.name.toLowerCase(), key) ||
        isWholeWordSubstring(key, c.name.toLowerCase()),
    );

    if (!match) {
      const created = await prisma.brand.create({ data: { clientId, name, isClientBrand: false } });
      canonicals.push({ brandId: created.id, name });
      resolved.set(key, created.id);
      continue;
    }

    const canRename = match.brandId !== clientBrandId && name.length < match.name.length;
    if (canRename) {
      await prisma.brand.update({ where: { id: match.brandId }, data: { name } });
      await prisma.brandAlias
        .create({ data: { brandId: match.brandId, alias: match.name } })
        .catch((err) => {
          if (!isUniqueViolation(err)) throw err;
        });
      match.name = name; // this cluster's canonical is now the shorter text
      resolved.set(key, match.brandId);
    } else {
      await prisma.brandAlias
        .create({ data: { brandId: match.brandId, alias: name } })
        .catch((err) => {
          if (!isUniqueViolation(err)) throw err;
        });
      resolved.set(key, match.brandId);
    }
  }

  return resolved;
}
