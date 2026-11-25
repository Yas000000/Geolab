import { siteDomain } from "@/lib/citations";

/**
 * Other names AI answers use for a client besides its brand name (Client.otherNames,
 * typed in Settings or Add Client): "Alaco" for Alaco Ladder. The pipeline's parser
 * matches each one exactly like the brand name (case-insensitive, anywhere in the
 * answer, links included), so an answer naming only "Alaco" counts as a mention
 * (user, 2026-11-25).
 */

export const OTHER_NAMES_MIN_LENGTH = 3; // shorter names would match inside ordinary words
export const OTHER_NAMES_MAX = 10;
const MAX_LENGTH = 80;

export const OTHER_NAMES_HINT =
  "Names AI answers may use for this client besides the brand name, such as a short name. Separate them with commas. " +
  "Each one counts as a mention exactly like the brand name, wherever it appears in an answer, so avoid ordinary words. " +
  "The client's domain always counts.";

/**
 * Cleans what was typed (commas or new lines between names): trimmed, repeats and the
 * brand name itself dropped. Returns an error message instead when a name is too short
 * or too long, or there are too many.
 */
export function cleanOtherNames(input: unknown, brandName: string): string[] | string {
  const raw = Array.isArray(input) ? input.map(String) : typeof input === "string" ? input.split(/[,\n]/) : [];
  const seen = new Set([brandName.trim().toLowerCase()]);
  const names: string[] = [];
  for (const part of raw) {
    const name = part.replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (name.length < OTHER_NAMES_MIN_LENGTH) {
      return `"${name}" is too short. Other names need at least ${OTHER_NAMES_MIN_LENGTH} characters, since shorter ones would match inside ordinary words.`;
    }
    if (name.length > MAX_LENGTH) return `"${name.slice(0, 30)}…" is too long (${MAX_LENGTH} characters at most).`;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length > OTHER_NAMES_MAX) return `At most ${OTHER_NAMES_MAX} other names.`;
  return names;
}

export const EXACT_MATCH_HINT =
  "Count the brand name and other names only as whole words with the same capitals. Use it when the name is " +
  "part of other brands or ordinary words: for a brand called \"Spark\", \"SparkPost\" and \"spark plugs\" then " +
  "don't count. The domain still counts however it's written.";

/**
 * Every name the pipeline's parser should count as the client besides the brand name:
 * the other names, plus the bare domain ("alacoladder.com"), since the client's domain
 * written in an answer is a mention too. In the default matching the brand name alone
 * already covers a domain that contains it; exact matching ("SignUp", same capitals)
 * doesn't cover "signup.com", so the domain is always added there.
 */
export function pipelineAliases(client: {
  name: string;
  domain: string | null;
  otherNames: string[];
  exactNameMatch?: boolean;
}): string[] {
  const aliases = [...client.otherNames];
  const site = siteDomain(client.domain);
  if (site && (client.exactNameMatch || !site.includes(client.name.toLowerCase()))) aliases.push(site);
  return aliases;
}

/**
 * Under exact matching, whether a brand name the extraction listed is the client itself:
 * the brand name or an other name, any capitals, optionally as a domain ("SignUp.com"),
 * or the client's own domain. "SignUpGenius" and "SignUp Genius" are not.
 */
export function isExactClientLabel(
  label: string,
  client: { name: string; domain: string | null; otherNames: string[] },
): boolean {
  const key = (s: string) => s.trim().toLowerCase().replace(/^www\./, "").replace(/\.(com|org|net|io|co|us)$/, "").trim();
  const k = key(label);
  if (!k) return false;
  const site = siteDomain(client.domain);
  return [client.name, ...client.otherNames, ...(site ? [site] : [])].some((n) => key(n) === k);
}
