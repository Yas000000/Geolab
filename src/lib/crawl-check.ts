import { prisma } from "@/lib/prisma";

export interface CrawlVendorResult {
  vendor: "claude" | "gemini" | "chatgpt";
  tier: string;
  confidence: "high" | "medium";
  success: boolean;
  detail: string;
}

export const CRAWL_VENDOR_LABEL: Record<CrawlVendorResult["vendor"], string> = {
  claude: "Claude",
  gemini: "Gemini",
  chatgpt: "ChatGPT",
};

// What each vendor's check can actually prove (python_pipeline/crawlability.py).
export const CRAWL_VENDOR_METHOD: Record<CrawlVendorResult["vendor"], string> = {
  claude: "Claude's own servers fetched the page live",
  gemini: "Gemini fetched the page (Google may serve it from its cache)",
  chatgpt: "ChatGPT has no fetch tool; this checks its search finds the site's own pages",
};

// Monthly for clients on a recurring schedule (cron/nightly); MANUAL clients
// only get checked from the Settings button, same rule as paid GEO runs.
export const CRAWL_CHECK_INTERVAL_DAYS = 30;

/** The client's homepage URL from a stored domain ("example.com" -> "https://example.com/"). */
export function siteUrl(domain: string): string {
  const d = domain.trim();
  return /^https?:\/\//i.test(d) ? d : `https://${d.replace(/\/+$/, "")}/`;
}

/**
 * PYTHON_CRAWL_CHECK_URL wins for local dev (a second local uvicorn, since
 * next dev doesn't serve api/*.py); otherwise the same deployment's
 * /api/crawl_check -- from the incoming request when there is one, else the
 * stable production domain (see scheduled-run.ts for why not VERCEL_URL).
 */
function crawlCheckUrl(request?: Request): string {
  if (process.env.PYTHON_CRAWL_CHECK_URL) return process.env.PYTHON_CRAWL_CHECK_URL;
  if (request) return new URL("/api/crawl_check", request.url).toString();
  return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/crawl_check`;
}

export type CrawlCheckOutcome =
  | { ok: true; id: string; checkedAt: Date; results: CrawlVendorResult[] }
  | { ok: false; reason: "client_not_found" | "no_domain" | "failed"; error?: string };

export async function runCrawlCheck(clientId: string, triggeredBy: string, request?: Request): Promise<CrawlCheckOutcome> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { domain: true, brands: { where: { isClientBrand: true }, select: { name: true }, take: 1 } },
  });
  if (!client) return { ok: false, reason: "client_not_found" };
  if (!client.domain) return { ok: false, reason: "no_domain" };

  let url = siteUrl(client.domain);
  let results: CrawlVendorResult[];
  try {
    const res = await fetch(crawlCheckUrl(request), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, brand: client.brands[0]?.name ?? null }),
    });
    if (!res.ok) throw new Error(`crawl_check returned ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { url: string; results: CrawlVendorResult[] };
    url = data.url || url; // where the site's own redirects landed -- what was actually checked
    results = data.results;
  } catch (err) {
    return { ok: false, reason: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  const row = await prisma.crawlCheck.create({
    data: { clientId, url, triggeredBy, results: results as unknown as object[] },
  });
  return { ok: true, id: row.id, checkedAt: row.checkedAt, results };
}

/** Clients on a recurring schedule whose last crawl check is older than the interval (or missing). */
export async function clientsDueForCrawlCheck(now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - CRAWL_CHECK_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
  const clients = await prisma.client.findMany({
    where: { schedule: { not: "MANUAL" }, domain: { not: null } },
    select: { id: true, crawlChecks: { orderBy: { checkedAt: "desc" }, take: 1, select: { checkedAt: true } } },
  });
  return clients.filter((c) => !c.crawlChecks[0] || c.crawlChecks[0].checkedAt < cutoff).map((c) => c.id);
}

export async function latestCrawlCheck(clientId: string) {
  const row = await prisma.crawlCheck.findFirst({ where: { clientId }, orderBy: { checkedAt: "desc" } });
  return row ? { ...row, results: row.results as unknown as CrawlVendorResult[] } : null;
}
