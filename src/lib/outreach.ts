import { Agent, fetch as undiciFetch } from "undici";
import { prisma } from "@/lib/prisma";
import { siteDomain, summarizeCitations, type CitedAnswer } from "@/lib/citations";

// The Outreach Plan tab (python_pipeline/outreach.py does the research and scoring).
// A build costs real money, mostly site research with web search, so it only ever runs
// when someone clicks Build or Rebuild on the tab: no cron, no queue, no auto-build after
// a crawl. Research is kept per client and site (OutreachSite), so a rebuild pays only
// for sites it hasn't researched, and a build that stops partway resumes for free.
//
// A build runs in steps, each in its own function invocation (route /outreach/step,
// started with next/server's after()): check the cited pages, research the sites (as many
// as fit in one invocation's time, then the next invocation carries on), then the plan
// and its estimates. A function stops at maxDuration (800s), and one build can need more.

/** Third-party sites researched per build: the crawl's most-cited, as on the Citations page.
 * OUTREACH_TEST_SITE_LIMIT caps it for a cheap local test build; never set in production. */
export const OUTREACH_SITE_LIMIT = Number(process.env.OUTREACH_TEST_SITE_LIMIT) || 20;
/** Must match RESEARCH_SCHEMA in python_pipeline/outreach.py: older research is redone. */
const RESEARCH_SCHEMA = 3;
const RESEARCH_MODEL = "claude-opus-5-5";
// Cost guides for the confirmation, from measured runs (geo-citation-checker, 2026-11-11:
// 20 sites researched for $9.33; action estimates about $0.03 per prompt).
export const COST_PER_SITE = 0.47;
export const COST_PER_PROMPT = 0.035;
const COST_PLACED_RATE = 0.01;
/** Google's copy of pages that block the server, through Serper ($1 per 1,000 searches): about
 * 500 searches for a crawl whose top sites block plain requests (Yellowbrick, 2026-11-13). */
export const COST_PAGE_CHECKS = process.env.SERPER_API_KEY ? 0.5 : 0;
const RESEARCH_CONCURRENCY = 6;
/** No new research starts after this much of an invocation; in-flight ones still finish. */
const LAUNCH_BUDGET_MS = 6 * 60_000;
/** The plan step needs a few minutes of its own; later than this it moves to a fresh invocation. */
const PLAN_START_LIMIT_MS = 7 * 60_000;
/** A RUNNING build with no progress for this long was cut off (the function's time limit). */
const STALE_MINUTES = 20;
const LIVE_SEARCH_TAG = "live search";

// Research and the plan step each run up to a few minutes inside the Python function, so
// the default 300s header timeout of Node's fetch must not cut them off first.
const pythonAgent = new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 });

export type OutreachProgress = { step: string; done?: number; total?: number };

interface CellIn {
  mentioned: boolean;
  rank: number | null;
  full_response: string;
  citations: { url: string; title: string | null; domain: string }[];
  error: null;
}
interface RowIn {
  prompt: string;
  category: string | null;
  platforms: Record<string, CellIn>;
}
interface SiteStats {
  citations: number;
  prompts: string[];
  urls: [string, number][];
  titles: Record<string, string>;
}
type PageCheck = Record<string, unknown>;
type Research = Record<string, unknown> & { schema?: number; error?: string };

/** What a RUNNING build carries from one step to the next (stored in OutreachPlan.plan). */
interface BuildState {
  stage: "check" | "research" | "plan";
  targets?: string[];
  stats?: Record<string, SiteStats>;
  namedBrands?: string[];
  totalPrompts?: number;
  checks?: Record<string, Record<string, PageCheck>>;
  pageCount?: number;
  /** Sites researched (or tried) in this build: researched ones are in OutreachSite. */
  attempted?: string[];
  failed?: Record<string, string>;
  researchTotal?: number;
}

/**
 * PYTHON_OUTREACH_URL wins for local dev (a local uvicorn, since next dev doesn't serve
 * api/*.py); otherwise this deployment's /api/outreach, as crawl-check.ts does.
 */
function outreachPythonUrl(origin: string): string {
  return process.env.PYTHON_OUTREACH_URL || `${origin}/api/outreach`;
}

async function py<T>(origin: string, body: Record<string, unknown>): Promise<T> {
  const res = await undiciFetch(outreachPythonUrl(origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    dispatcher: pythonAgent,
  });
  if (!res.ok) throw new Error(`outreach ${String(body.action)} returned ${res.status}: ${(await res.text()).slice(0, 800)}`);
  return (await res.json()) as T;
}

/** The newest completed crawl with Live Search answers that cite something. */
export async function latestCitedCrawl(clientId: string) {
  return prisma.run.findFirst({
    where: {
      clientId,
      status: "COMPLETE",
      rawResponses: {
        some: { modelId: { contains: LIVE_SEARCH_TAG, mode: "insensitive" }, citations: { some: {} } },
      },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true },
  });
}

/** The crawl's most-cited third-party sites, by answers citing them (the Citations page's count). */
function targetSites(answers: CitedAnswer[], ownDomain: string | null): string[] {
  return summarizeCitations(answers, ownDomain)
    .sites.filter((s) => !s.isOwn)
    .slice(0, OUTREACH_SITE_LIMIT)
    .map((s) => s.domain);
}

/** The crawl's answers, one row per tracked prompt in prompt order, one cell per engine that answered. */
async function crawlRows(runId: string, ownDomain: string | null) {
  const answers = (
    await prisma.rawResponse.findMany({
      where: { runId, modelId: { contains: LIVE_SEARCH_TAG, mode: "insensitive" }, responseText: { not: "" } },
      select: {
        platform: true,
        responseText: true,
        prompt: { select: { text: true, category: true, position: true } },
        citations: { orderBy: { position: "asc" }, select: { url: true, title: true, domain: true } },
        parsedResult: {
          select: {
            clientBrandMentioned: true,
            clientBrandRank: true,
            mentions: { orderBy: { position: "asc" }, select: { rawLabel: true } },
          },
        },
      },
    })
  ).sort((a, b) => a.prompt.position - b.prompt.position || a.platform.localeCompare(b.platform));
  const byPrompt = new Map<string, RowIn>();
  const extracted: string[][] = [];
  for (const a of answers) {
    const key = a.prompt.text.trim().toLowerCase();
    const row = byPrompt.get(key) ?? { prompt: a.prompt.text, category: a.prompt.category, platforms: {} };
    row.platforms[a.platform] = {
      mentioned: !!a.parsedResult?.clientBrandMentioned,
      rank: a.parsedResult?.clientBrandMentioned ? (a.parsedResult.clientBrandRank ?? null) : null,
      full_response: a.responseText,
      citations: a.citations.map((c) => ({ url: c.url, title: c.title, domain: c.domain.toLowerCase() })),
      error: null,
    };
    byPrompt.set(key, row);
    extracted.push((a.parsedResult?.mentions ?? []).map((m) => m.rawLabel));
  }
  const cited: CitedAnswer[] = answers.map((a) => ({
    platform: a.platform,
    promptText: a.prompt.text,
    promptCategory: a.prompt.category,
    citations: a.citations,
  }));
  return {
    rows: [...byPrompt.values()],
    platforms: [...new Set(answers.map((a) => a.platform))].sort(),
    extracted,
    targets: targetSites(cited, ownDomain),
  };
}

function researchUsable(research: unknown): boolean {
  const r = research as Research | null;
  return !!r && !r.error && r.schema === RESEARCH_SCHEMA;
}

async function clientBrand(clientId: string) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, domain: true, brands: { where: { isClientBrand: true }, select: { name: true }, take: 1 } },
  });
  return client ? { brand: client.brands[0]?.name ?? client.name, domain: client.domain } : null;
}

/** A RUNNING build that stopped moving is marked failed, so a new one can start. */
async function expireStaleBuilds(clientId: string) {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60_000);
  await prisma.outreachPlan.updateMany({
    where: { clientId, status: "RUNNING", updatedAt: { lt: cutoff } },
    data: {
      status: "FAILED",
      completedAt: new Date(),
      error: "The build stopped before finishing. Research finished so far is saved, so building again continues from there.",
    },
  });
}

export interface OutreachOverview {
  crawl: { id: string; startedAt: Date } | null;
  targets: string[];
  sitesToResearch: number;
  promptCount: number;
  estimatesReused: boolean;
  costEstimate: number;
}

/** What a build from the latest crawl would do and roughly cost, for the confirmation. */
export async function outreachOverview(clientId: string): Promise<OutreachOverview> {
  const [info, crawl] = await Promise.all([clientBrand(clientId), latestCitedCrawl(clientId)]);
  if (!info || !crawl) {
    return { crawl: null, targets: [], sitesToResearch: 0, promptCount: 0, estimatesReused: false, costEstimate: 0 };
  }
  const rows = await prisma.rawResponse.findMany({
    where: { runId: crawl.id, modelId: { contains: LIVE_SEARCH_TAG, mode: "insensitive" }, responseText: { not: "" } },
    select: { platform: true, prompt: { select: { text: true, category: true } }, citations: { select: { url: true, title: true, domain: true } } },
  });
  const answers: CitedAnswer[] = rows.map((r) => ({
    platform: r.platform,
    promptText: r.prompt.text,
    promptCategory: r.prompt.category,
    citations: r.citations,
  }));
  const targets = targetSites(answers, siteDomain(info.domain));
  const cached = await prisma.outreachSite.findMany({
    where: { clientId, domain: { in: targets } },
    select: { domain: true, research: true },
  });
  const usable = new Set(cached.filter((c) => researchUsable(c.research)).map((c) => c.domain));
  const sitesToResearch = targets.filter((d) => !usable.has(d)).length;
  const promptCount = new Set(rows.map((r) => r.prompt.text)).size;
  const lastComplete = await prisma.outreachPlan.findFirst({
    where: { clientId, status: "COMPLETE" },
    orderBy: { createdAt: "desc" },
    select: { runId: true },
  });
  // Estimates are keyed by their inputs; from the same crawl and the same research they come back unchanged.
  const estimatesReused = lastComplete?.runId === crawl.id && sitesToResearch === 0;
  const costEstimate =
    sitesToResearch * COST_PER_SITE +
    (estimatesReused ? 0 : promptCount * COST_PER_PROMPT + COST_PLACED_RATE) +
    COST_PAGE_CHECKS;
  return { crawl, targets, sitesToResearch, promptCount, estimatesReused, costEstimate };
}

export type StartOutcome =
  | { ok: true; planId: string; runId: string }
  | { ok: false; reason: "client_not_found" | "no_domain" | "no_crawl" | "running" };

/** Creates the RUNNING build row. The caller then runs the first step after replying. */
export async function startOutreachBuild(clientId: string, triggeredBy: string): Promise<StartOutcome> {
  const info = await clientBrand(clientId);
  if (!info) return { ok: false, reason: "client_not_found" };
  if (!info.domain) return { ok: false, reason: "no_domain" };
  await expireStaleBuilds(clientId);
  const running = await prisma.outreachPlan.findFirst({ where: { clientId, status: "RUNNING" }, select: { id: true } });
  if (running) return { ok: false, reason: "running" };
  const crawl = await latestCitedCrawl(clientId);
  if (!crawl) return { ok: false, reason: "no_crawl" };
  const plan = await prisma.outreachPlan.create({
    data: { clientId, runId: crawl.id, triggeredBy, progress: { step: "Starting" }, plan: { stage: "check" } },
  });
  return { ok: true, planId: plan.id, runId: crawl.id };
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

/** Hands the build to a fresh invocation of the step route. */
async function continueInNewInvocation(planId: string, clientId: string, origin: string) {
  const res = await fetch(`${origin}/api/clients/${clientId}/outreach/step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId }),
  });
  if (!res.ok) throw new Error(`Couldn't continue the build (step route returned ${res.status}).`);
}

/**
 * Runs as much of a RUNNING build as fits in this invocation, then either finishes it
 * (COMPLETE with the plan, or FAILED with the reason) or hands it to the next invocation.
 * origin: this deployment's own address, for the Python function and the step route.
 */
export async function runOutreachStep(planId: string, origin: string): Promise<void> {
  const startedAt = Date.now();
  const plan = await prisma.outreachPlan.findUnique({ where: { id: planId } });
  if (!plan || plan.status !== "RUNNING") return;
  let cost = plan.costUsd;
  const state: BuildState = { ...((plan.plan as BuildState | null) ?? { stage: "check" }) };
  const save = (progress: OutreachProgress) =>
    prisma.outreachPlan.update({ where: { id: planId }, data: { progress, costUsd: cost, plan: state as object } });

  try {
    const info = await clientBrand(plan.clientId);
    if (!info?.domain) throw new Error("The client has no domain set.");
    const { brand, domain } = info;
    const crawl = await crawlRows(plan.runId, siteDomain(domain));

    if (state.stage === "check") {
      const sites = await py<{ stats: Record<string, SiteStats>; named_brands: string[]; total_prompts: number }>(origin, {
        action: "sites",
        client_domain: domain,
        rows: crawl.rows,
        platforms: crawl.platforms,
        target_domains: crawl.targets,
        extracted: crawl.extracted,
      });
      // Listing check of every cited page on the target sites: fresh each build, since listings change.
      const urlsBySite = Object.fromEntries(Object.entries(sites.stats).map(([d, s]) => [d, s.urls.map(([u]) => u)]));
      const pageCount = Object.values(urlsBySite).reduce((n, u) => n + u.length, 0);
      await save({ step: `Checking ${pageCount} cited pages` });
      const checked = await py<{ checks: Record<string, Record<string, PageCheck>>; cost: number }>(origin, {
        action: "check_pages",
        brand,
        client_domain: domain,
        urls_by_site: urlsBySite,
        named_brands: sites.named_brands,
      });
      cost += checked.cost;
      // A page the server still can't load keeps what Chrome on the user's PC last read on it
      // (the tab's "Re-check blocked pages", helper/outreach_helper.py), with that check's date.
      const chrome = await chromeChecksFromLastPlan(plan.clientId);
      for (const pages of Object.values(checked.checks)) {
        for (const [url, check] of Object.entries(pages)) {
          const earlier = chrome.get(url);
          if (earlier && (check.status === "unreachable" || check.status === "indexed")) pages[url] = earlier;
        }
      }
      Object.assign(state, {
        stage: "research",
        targets: crawl.targets,
        stats: sites.stats,
        namedBrands: sites.named_brands,
        totalPrompts: sites.total_prompts,
        checks: checked.checks,
        pageCount,
        attempted: [],
        failed: {},
      });
      await save({ step: "Researching sites", done: 0 });
    }

    if (state.stage === "research") {
      const siteDomains = state.targets!.filter((d) => state.stats![d]);
      const cached = new Map(
        (
          await prisma.outreachSite.findMany({
            where: { clientId: plan.clientId, domain: { in: siteDomains } },
            select: { domain: true, research: true, researchedAt: true },
          })
        ).map((c) => [c.domain, c]),
      );
      const attempted = new Set(state.attempted);
      const todo = siteDomains.filter((d) => !attempted.has(d) && !researchUsable(cached.get(d)?.research));
      state.researchTotal ??= todo.length;
      const progress = () => ({ step: "Researching sites", done: state.attempted!.length, total: state.researchTotal });
      await save(progress());
      await pool(todo, RESEARCH_CONCURRENCY, async (site) => {
        if (Date.now() - startedAt > LAUNCH_BUDGET_MS) return; // the next invocation picks it up
        const earlier = cached.get(site);
        const res = await py<{ research: Research; cost: number }>(origin, {
          action: "research",
          brand,
          client_domain: domain,
          site,
          stats: state.stats![site],
          total_prompts: state.totalPrompts,
          pages: state.checks![site] ?? {},
          earlier: earlier && !(earlier.research as Research).error ? earlier.research : null,
          earlier_at: earlier?.researchedAt.toISOString() ?? null,
        }).catch((err) => ({ research: { error: err instanceof Error ? err.message : String(err) } as Research, cost: 0 }));
        cost += res.cost;
        if (res.research.error) {
          state.failed![site] = res.research.error;
        } else {
          const data = { research: res.research as object, model: RESEARCH_MODEL, costUsd: res.cost, researchedAt: new Date() };
          await prisma.outreachSite.upsert({
            where: { clientId_domain: { clientId: plan.clientId, domain: site } },
            create: { clientId: plan.clientId, domain: site, ...data },
            update: data,
          });
        }
        state.attempted!.push(site);
        await save(progress());
      });
      const left = todo.filter((d) => !state.attempted!.includes(d));
      if (left.length) {
        await save(progress());
        await continueInNewInvocation(planId, plan.clientId, origin);
        return;
      }
      state.stage = "plan";
      await save({ step: "Estimating each prompt's actions" });
      if (Date.now() - startedAt > PLAN_START_LIMIT_MS) {
        await continueInNewInvocation(planId, plan.clientId, origin);
        return;
      }
    }

    // Priority, the per-prompt actions and their AI estimates. Estimates and the placed-list rate
    // from the client's last finished plan are reused where their inputs haven't changed.
    const siteDomains = state.targets!.filter((d) => state.stats![d]);
    const research = new Map(
      (
        await prisma.outreachSite.findMany({
          where: { clientId: plan.clientId, domain: { in: siteDomains } },
          select: { domain: true, research: true, researchedAt: true },
        })
      ).map((c) => [c.domain, c]),
    );
    const siteCache = Object.fromEntries(
      siteDomains.map((d) => {
        const r = research.get(d);
        const usable = r && researchUsable(r.research);
        return [
          d,
          {
            research: usable ? r.research : { error: state.failed?.[d] ?? "not researched" },
            pages: state.checks![d] ?? {},
            researched_at: usable ? r.researchedAt.toISOString() : null,
          },
        ];
      }),
    );
    const last = await prisma.outreachPlan.findFirst({
      where: { clientId: plan.clientId, status: "COMPLETE" },
      orderBy: { createdAt: "desc" },
      select: { plan: true },
    });
    const lastCaches = (last?.plan as { caches?: { placed?: unknown; estimates?: unknown } } | null)?.caches ?? {};
    const result = await py<{ plan: Record<string, unknown>; caches: Record<string, unknown>; cost: number }>(origin, {
      action: "plan",
      brand,
      client_domain: domain,
      rows: crawl.rows,
      platforms: crawl.platforms,
      target_domains: state.targets,
      named_brands: state.namedBrands,
      site_cache: siteCache,
      placed_cache: lastCaches.placed ?? null,
      estimate_cache: lastCaches.estimates ?? {},
    });
    cost += result.cost;
    const crawlRun = await prisma.run.findUniqueOrThrow({ where: { id: plan.runId }, select: { startedAt: true } });
    await prisma.outreachPlan.update({
      where: { id: planId },
      data: {
        status: "COMPLETE",
        completedAt: new Date(),
        progress: { step: "Done" },
        costUsd: cost,
        plan: {
          ...result.plan,
          caches: result.caches,
          brand,
          domain,
          crawlDate: crawlRun.startedAt.toISOString(),
          platforms: crawl.platforms,
          researchedThisBuild: state.attempted?.length ?? 0,
          pagesChecked: state.pageCount ?? 0,
        } as object,
      },
    });
  } catch (err) {
    await prisma.outreachPlan
      .update({
        where: { id: planId },
        data: { status: "FAILED", completedAt: new Date(), costUsd: cost, error: err instanceof Error ? err.message : String(err) },
      })
      .catch(() => undefined);
  }
}

// ── Re-check blocked pages (phase 4) ─────────────────────────────────────────
// The tab's button sends pages the server couldn't load to the Outreach Helper on the user's
// PC (helper/outreach_helper.py), which reads them in real Chrome; the tab posts the results
// here. Applying them recomputes the plan with no paid calls (python plan with ai=false).

/** The fields of one page's listing check, as the plan stores it alongside url/title/count. */
const CHECK_FIELDS = ["status", "fetched_with", "listed", "position", "competitors_on_page", "competitors_found", "reason", "checked_at"];

interface StoredPlan {
  sites: { domain: string; research: Research; researched_at: string | null; pages: (PageCheck & { url: string })[] }[];
  caches?: { placed?: unknown; estimates?: unknown };
  named_brands?: string[];
  crawlDate?: string;
  platforms?: string[];
  researchedThisBuild?: number;
  pagesChecked?: number;
}

function checksFromPlan(plan: StoredPlan): Record<string, Record<string, PageCheck>> {
  return Object.fromEntries(
    plan.sites.map((s) => [
      s.domain,
      Object.fromEntries(s.pages.map((p) => [p.url, Object.fromEntries(CHECK_FIELDS.filter((k) => k in p).map((k) => [k, p[k]]))])),
    ]),
  );
}

/** Chrome checks that loaded a page, from the client's last finished plan, by URL. */
async function chromeChecksFromLastPlan(clientId: string): Promise<Map<string, PageCheck>> {
  const last = await prisma.outreachPlan.findFirst({
    where: { clientId, status: "COMPLETE" },
    orderBy: { createdAt: "desc" },
    select: { plan: true },
  });
  const out = new Map<string, PageCheck>();
  const plan = last?.plan as StoredPlan | null;
  for (const [, pages] of Object.entries(plan?.sites ? checksFromPlan(plan) : {})) {
    for (const [url, check] of Object.entries(pages)) {
      if (check.fetched_with === "chrome" && check.status === "checked") out.set(url, check);
    }
  }
  return out;
}

export type RecheckOutcome =
  | { ok: true; applied: number; loaded: number; listed: number }
  | { ok: false; reason: "no_plan" | "running" | "client_not_found" };

/**
 * Saves a re-check's results into the client's latest plan and recomputes it with no paid calls:
 * estimates and the placed-list rate come from that plan's caches. A result replaces a page's
 * check when Chrome loaded the page, or when the server couldn't load it either.
 */
export async function applyRecheck(
  clientId: string,
  incoming: Record<string, Record<string, PageCheck>>,
  origin: string,
): Promise<RecheckOutcome> {
  const info = await clientBrand(clientId);
  if (!info?.domain) return { ok: false, reason: "client_not_found" };
  await expireStaleBuilds(clientId);
  if (await prisma.outreachPlan.findFirst({ where: { clientId, status: "RUNNING" }, select: { id: true } })) {
    return { ok: false, reason: "running" };
  }
  const row = await prisma.outreachPlan.findFirst({ where: { clientId, status: "COMPLETE" }, orderBy: { createdAt: "desc" } });
  const stored = row?.plan as (StoredPlan & Record<string, unknown>) | null;
  if (!row || !stored?.sites) return { ok: false, reason: "no_plan" };
  const { brand, domain } = info;

  const checks = checksFromPlan(stored);
  let applied = 0;
  let loaded = 0;
  let listed = 0;
  for (const [site, pages] of Object.entries(incoming)) {
    for (const [url, check] of Object.entries(pages ?? {})) {
      const current = checks[site]?.[url];
      if (!current || typeof check !== "object" || !check) continue;
      if (check.status === "checked" || current.status === "unreachable") {
        checks[site][url] = { ...check, fetched_with: "chrome" };
        applied += 1;
        if (check.status === "checked") loaded += 1;
        if (check.listed) listed += 1;
      }
    }
  }

  const crawl = await crawlRows(row.runId, siteDomain(domain));
  const namedBrands =
    stored.named_brands ??
    (
      await py<{ named_brands: string[] }>(origin, {
        action: "sites",
        client_domain: domain,
        rows: crawl.rows,
        platforms: crawl.platforms,
        target_domains: crawl.targets,
        extracted: crawl.extracted,
      })
    ).named_brands;
  const research = new Map(
    (
      await prisma.outreachSite.findMany({
        where: { clientId, domain: { in: stored.sites.map((s) => s.domain) } },
        select: { domain: true, research: true, researchedAt: true },
      })
    ).map((c) => [c.domain, c]),
  );
  const siteCache = Object.fromEntries(
    stored.sites.map((s) => {
      const r = research.get(s.domain);
      const usable = r && researchUsable(r.research);
      return [
        s.domain,
        {
          research: usable ? r.research : { error: s.research.error ?? "not researched" },
          pages: checks[s.domain] ?? {},
          researched_at: usable ? r.researchedAt.toISOString() : null,
        },
      ];
    }),
  );
  const result = await py<{ plan: Record<string, unknown>; caches: Record<string, unknown> }>(origin, {
    action: "plan",
    brand,
    client_domain: domain,
    rows: crawl.rows,
    platforms: crawl.platforms,
    target_domains: stored.sites.map((s) => s.domain),
    named_brands: namedBrands,
    site_cache: siteCache,
    placed_cache: stored.caches?.placed ?? null,
    estimate_cache: stored.caches?.estimates ?? {},
    ai: false,
  });
  await prisma.outreachPlan.update({
    where: { id: row.id },
    data: {
      plan: {
        ...result.plan,
        caches: result.caches,
        brand,
        domain,
        crawlDate: stored.crawlDate,
        platforms: stored.platforms,
        researchedThisBuild: stored.researchedThisBuild,
        pagesChecked: stored.pagesChecked,
        recheck: { at: new Date().toISOString(), applied, loaded, listed },
      } as object,
    },
  });
  return { ok: true, applied, loaded, listed };
}

export async function latestOutreachPlans(clientId: string) {
  await expireStaleBuilds(clientId);
  const [latest, complete] = await Promise.all([
    prisma.outreachPlan.findFirst({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, progress: true, error: true, costUsd: true, createdAt: true, updatedAt: true, runId: true },
    }),
    prisma.outreachPlan.findFirst({ where: { clientId, status: "COMPLETE" }, orderBy: { createdAt: "desc" } }),
  ]);
  return { latest, complete };
}
