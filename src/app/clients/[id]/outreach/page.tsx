import { Fragment } from "react";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { OutreachBuildPanel } from "@/components/outreach-build-panel";
import { OutreachRecheckPanel } from "@/components/outreach-recheck-panel";
import { siteDomain } from "@/lib/citations";
import { CATEGORY_LABEL } from "@/lib/geo-platform-map";
import { COST_PAGE_CHECKS, COST_PER_PROMPT, COST_PER_SITE, latestOutreachPlans, outreachOverview } from "@/lib/outreach";

export const dynamic = "force-dynamic";

// The plan as python_pipeline/outreach.py build_plan returns it (OutreachPlan.plan).
interface PageCheck {
  url: string;
  title: string;
  count: number;
  status: "checked" | "indexed" | "unreachable";
  listed?: boolean;
  position?: number | null;
  competitors_on_page?: string[];
  reason?: string;
  fetched_with?: string;
  checked_at?: string;
}
interface Route {
  type: string;
  label: string;
  summary: string;
  cost: string | null;
  deadline: string | null;
  source_url: string | null;
  fee_unknown: boolean;
  fee_from?: { date: string; source_url: string | null };
}
interface Research {
  error?: string;
  site_type_label?: string;
  who_runs_it?: string;
  competitor_owned?: boolean;
  routes?: Route[];
  primary_label?: string;
  next_step?: string;
  why?: string;
  evidence?: string;
}
interface Site {
  domain: string;
  kind: "outreach" | "own_page" | "skip" | "unknown";
  tier: string;
  existing_tier: string | null;
  potential_tier?: string | null;
  prompt_count: number;
  citations: number;
  prompts: string[];
  top_url: string;
  top_title: string;
  page_check: PageCheck;
  pages: PageCheck[];
  listing: { listed: PageCheck[]; missing: PageCheck[]; unknown: PageCheck[]; total: number };
  listing_changed: boolean;
  researched_at: string | null;
  research: Research;
}
interface Lever {
  lever: "own" | "list";
  domain: string;
  label: string;
  subtitle: string;
  prompt_count: number;
  tier: string;
  existing_tier: string | null;
  potential_tier: string | null;
  num: number;
}
interface Rec {
  fee: string;
  text: string;
  rtype: string;
  lever?: string;
  comparable?: { text: string; detail: string };
  potential_text?: { text: string; detail: string };
  estimate?: { estimate: string; label: string; reason: string } | null;
}
interface Rate {
  low: number;
  high: number;
  source: string;
  reason: string;
}
interface Plan {
  brand: string;
  crawlDate: string;
  pagesChecked: number;
  sites: Site[];
  levers: Lever[];
  ranked: { num: number; ref: string }[];
  groups: { key: string; label: string; domains: string[]; prompt_count: number }[];
  total_prompts: number;
  existing_weight: number;
  rates: { own: Rate; list: Rate | null };
  prompts: { prompt: string; category: string | null; recommendations: Rec[] }[];
  named_brands?: string[];
  recheck?: { at: string; applied: number; loaded: number; listed: number };
}

// Pages the server couldn't read because the site refuses automated visits (or only Google's copy
// was read): what "Re-check blocked pages" sends to the Outreach Helper. A missing page (404) or a
// PDF isn't blocked, so it isn't re-checked.
function blockedPages(plan: Plan): { site: string; url: string }[] {
  return plan.sites.flatMap((s) =>
    s.pages
      .filter((p) => p.status === "indexed" || (p.status === "unreachable" && !/^(HTTP 404|HTTP 410|not a web page)/.test(p.reason ?? "")))
      .map((p) => ({ site: s.domain, url: p.url })),
  );
}

const crawlDay = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const pct = (x: number) => `${Math.round(x * 100)}%`;
const money = (n: number) => `$${n.toFixed(2)}`;

const URL_RE = /(https?:\/\/[^\s)<>"]+[^\s)<>".,;:!?])/g;

function ExtLink({ url, children }: { url: string; children?: React.ReactNode }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-blue-700 [overflow-wrap:anywhere] hover:underline dark:text-blue-400">
      {children ?? url}
    </a>
  );
}

/** Research prose with any URL in it made a link. */
function Prose({ text }: { text: string | undefined }) {
  if (!text) return null;
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) => (i % 2 ? <ExtLink key={i} url={part} /> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

const TIER_PILL: Record<string, string> = {
  High: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  Medium: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  Low: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
};

function Tier({ tier, suffix = "" }: { tier: string | null | undefined; suffix?: string }) {
  if (!tier) return <span className="text-xs text-zinc-400 dark:text-zinc-500">None</span>;
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TIER_PILL[tier] ?? TIER_PILL.Low}`}>
      {tier}
      {suffix}
    </span>
  );
}

function OnPage({ s }: { s: Site }) {
  const L = s.listing;
  if (s.kind === "own_page") return <span className="text-zinc-500 dark:text-zinc-400">Competitor page</span>;
  if (!L.listed.length && !L.missing.length) return <span className="text-zinc-500 dark:text-zinc-400">Couldn&apos;t check</span>;
  if (L.listed.length)
    return (
      <span className="text-emerald-700 dark:text-emerald-400">
        {L.total === 1 ? "Listed" : `Listed on ${L.listed.length} of ${L.total}`}
        {L.total > 1 && <span className="block text-xs text-zinc-500 dark:text-zinc-400">cited pages</span>}
      </span>
    );
  return (
    <span className="text-red-700 dark:text-red-400">
      Not listed
      {L.unknown.length ? (
        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
          on {L.missing.length} of {L.total} cited pages checked
        </span>
      ) : L.total > 1 ? (
        <span className="block text-xs text-zinc-500 dark:text-zinc-400">on any of {L.total} cited pages</span>
      ) : null}
    </span>
  );
}

/** Which of a site's cited pages were read in Chrome on the user's PC (Re-check blocked pages). */
function ChromeNote({ pages }: { pages: PageCheck[] }) {
  const tried = pages.filter((p) => p.fetched_with === "chrome");
  if (!tried.length) return null;
  const read = tried.filter((p) => p.status === "checked").length;
  const at = tried.map((p) => p.checked_at).filter(Boolean).sort().pop();
  const when = at ? ` (${crawlDay(new Date(at))})` : "";
  return (
    <p className="text-xs text-zinc-500 dark:text-zinc-400">
      {read
        ? `${read} of the cited pages ${read === 1 ? "was" : "were"} read in Chrome on this PC${when}, since the site blocks the portal's server.`
        : `The site blocks the portal's server, and Chrome on this PC couldn't read its pages either${when}.`}
    </p>
  );
}

function where(p: PageCheck): string {
  if (p.position === 1) return ", ahead of every other firm named in this crawl's answers";
  if (p.position) return `, after ${p.position - 1} of the other firms named in this crawl's answers`;
  return "";
}

function SiteCard({ s, num, brand, total }: { s: Site; num: number; brand: string; total: number }) {
  const r = s.research;
  const L = s.listing;
  const top = s.page_check;
  const indexed = (p: PageCheck) => (p.status === "indexed" ? ", per Google's copy of the page" : "");
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-950 text-xs font-semibold text-white dark:bg-zinc-50 dark:text-zinc-950">
          {num}
        </span>
        <span className="font-semibold text-zinc-950 dark:text-zinc-50">{s.domain}</span>
        <Tier tier={s.tier} suffix=" priority" />
        <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
          {r.primary_label}
        </span>
        {r.competitor_owned && (
          <span className="rounded-full border border-red-300 px-2 py-0.5 text-xs text-red-700 dark:border-red-800 dark:text-red-400">
            Competitor-owned
          </span>
        )}
      </div>
      <div className="mt-3 space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
        <div>
          <span className="font-medium text-zinc-500 dark:text-zinc-400">Cited on </span>
          <span>
            {s.prompt_count} of {total} prompts, {s.citations} citations. Most-cited page: {s.top_title || "untitled"}{" "}
            <ExtLink url={s.top_url} />
          </span>
        </div>
        <div>
          <span className="font-medium text-zinc-500 dark:text-zinc-400">
            On the {L.total === 1 ? "page" : "cited pages"} today{" "}
          </span>
          <span>
            {!L.listed.length && !L.missing.length ? (
              <>
                Couldn&apos;t load {L.total === 1 ? "the page" : `any of the ${L.total} cited pages`} to check
                {top.reason ? ` (${top.reason})` : ""}. The site blocks the portal&apos;s server; check it by hand for
                now.
              </>
            ) : L.total === 1 ? (
              L.listed.length ? (
                <>
                  {brand} is already listed{where(top)}
                  {indexed(top)}.{" "}
                  {top.competitors_on_page?.length ? `Also on the page: ${top.competitors_on_page.join(", ")}.` : ""}
                </>
              ) : (
                <>
                  {brand} isn&apos;t on it{indexed(top)}.{" "}
                  {top.competitors_on_page?.length
                    ? `Firms on the page from this crawl's answers: ${top.competitors_on_page.join(", ")}.`
                    : ""}
                </>
              )
            ) : (
              <>
                {L.listed.length
                  ? `${brand} is already listed on ${L.listed.length} of the ${L.total} cited pages`
                  : `${brand} isn't on any of the ${L.missing.length} cited pages checked`}
                {L.unknown.length ? `, and ${L.unknown.length} couldn't be checked` : ""}.{" "}
                {L.listed.length && L.missing.length
                  ? `Not on the other ${L.missing.length}${L.missing[0]?.url === s.top_url ? ", including the most-cited page" : ""}. `
                  : ""}
                {top.competitors_on_page?.length
                  ? `Firms on the most-cited page from this crawl's answers: ${top.competitors_on_page.join(", ")}.`
                  : ""}
              </>
            )}
          </span>
        </div>
        <ChromeNote pages={s.pages} />
        {L.listed.length > 0 && L.total > 1 && (
          <ul className="ml-4 list-disc space-y-1">
            {L.listed.slice(0, 8).map((p) => (
              <li key={p.url}>
                {p.title || "untitled"}
                {where(p)}
                {p.status === "indexed" ? " (per Google's copy of the page)" : ""}
                <div className="text-xs">
                  <ExtLink url={p.url} />
                </div>
              </li>
            ))}
            {L.listed.length > 8 && <li>and {L.listed.length - 8} more</li>}
          </ul>
        )}
        {s.listing_changed && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            The listing results changed since this site was researched
            {s.researched_at ? ` on ${crawlDay(new Date(s.researched_at))}` : ""}, so the routes below may not
            reflect them.
          </p>
        )}
        <div>
          <span className="font-medium text-zinc-500 dark:text-zinc-400">Who runs it </span>
          <span>
            <Prose text={r.who_runs_it} />
          </span>
        </div>
        {r.routes && r.routes.length > 0 && (
          <div>
            <div className="font-medium text-zinc-500 dark:text-zinc-400">
              Ways in
              {r.evidence === "unverified" && (
                <span className="ml-2 text-xs font-normal italic">not confirmed on the site&apos;s own pages</span>
              )}
            </div>
            <div>
              <ul className="mt-1 ml-4 list-disc space-y-1.5">
                {r.routes.map((route, i) => (
                  <li key={i}>
                    <strong>{route.label}:</strong> <Prose text={route.summary} />
                    {route.cost && <span className="ml-1 text-zinc-500 dark:text-zinc-400">Cost: {route.cost.replace(/\.$/, "")}.</span>}
                    {route.deadline && (
                      <span className="ml-1 text-zinc-500 dark:text-zinc-400">Deadline: {route.deadline.replace(/\.$/, "")}.</span>
                    )}
                    {route.fee_unknown && <span className="ml-1 text-zinc-500 dark:text-zinc-400">Fee not confirmed.</span>}
                    {route.fee_from && (
                      <span className="ml-1 text-zinc-500 dark:text-zinc-400">
                        Fee confirmed in earlier research{route.fee_from.date ? ` (${route.fee_from.date})` : ""}.
                      </span>
                    )}
                    {route.source_url && (
                      <div className="text-xs">
                        Source: <ExtLink url={route.source_url} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <div className="rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
          <span className="font-medium text-zinc-950 dark:text-zinc-50">Next step: </span>
          <Prose text={r.next_step} />
          {r.why && (
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              <Prose text={r.why} />
            </div>
          )}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Prompts citing this site:{" "}
          {s.prompts.slice(0, 4).map((p, i) => (
            <Fragment key={p}>
              &ldquo;{p}&rdquo;{i < Math.min(4, s.prompts.length) - 1 ? ", " : ""}
            </Fragment>
          ))}
          {s.prompts.length > 4 ? ` and ${s.prompts.length - 4} more` : ""}
        </p>
      </div>
    </div>
  );
}

export default async function OutreachPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await prisma.client.findUnique({ where: { id }, select: { id: true, name: true, domain: true } });
  if (!client) notFound();

  const [overview, { latest, complete }] = await Promise.all([outreachOverview(id), latestOutreachPlans(id)]);
  const plan = (complete?.plan ?? null) as Plan | null;
  const running = latest?.status === "RUNNING";
  const failed = latest?.status === "FAILED" ? latest : null;
  const newerCrawl = complete && overview.crawl && overview.crawl.id !== complete.runId;

  const disabledReason = !client.domain
    ? "Add the client's domain in Settings first."
    : !overview.crawl
      ? "Needs a Live Search crawl with citations. Run one from Settings first."
      : null;

  const sectionTitle = "mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
  const note = "mb-3 text-xs text-zinc-500 dark:text-zinc-400";
  const thead = "bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400";
  const tableWrap = "overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950";

  const sitesByDomain = new Map(plan?.sites.map((s) => [s.domain, s]) ?? []);
  const leversByKey = new Map(plan?.levers.map((l) => [l.lever, l]) ?? []);
  const ranked = (plan?.ranked ?? []).map((r) => {
    const [kind, key] = [r.ref.slice(0, r.ref.indexOf(":")), r.ref.slice(r.ref.indexOf(":") + 1)];
    return kind === "lever"
      ? { num: r.num, lever: leversByKey.get(key as "own" | "list")!, site: null }
      : { num: r.num, lever: null, site: sitesByDomain.get(key)! };
  });
  const numOf = new Map(ranked.filter((r) => r.site).map((r) => [r.site!.domain, r.num]));
  const targets = ranked.filter((r) => r.site && r.site.kind === "outreach");
  const ownPages = plan?.sites.filter((s) => s.kind === "own_page") ?? [];
  const ownLever = leversByKey.get("own");
  const skipped = plan?.sites.filter((s) => s.kind === "skip" || s.kind === "unknown") ?? [];
  const brand = plan?.brand ?? client.name;
  const blocked = plan ? blockedPages(plan) : [];
  const total = plan?.total_prompts ?? 0;

  // Prompt Action Plan rows grouped by prompt category, in prompt order.
  const promptGroups = new Map<string, Plan["prompts"]>();
  for (const p of plan?.prompts ?? []) {
    const key = p.category ?? "general";
    promptGroups.set(key, [...(promptGroups.get(key) ?? []), p]);
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{client.name}</h1>
        {client.domain && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{client.domain}</p>}
      </header>

      <section className="mb-8 rounded-lg border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className={sectionTitle}>Outreach Plan</h2>
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          {complete
            ? `Built ${crawlDay(complete.createdAt)} from the ${crawlDay(new Date(plan!.crawlDate))} crawl. That build cost ${money(complete.costUsd)}.`
            : "No outreach plan yet."}{" "}
          A build takes the {overview.targets.length || 20} sites the latest Live Search crawl cites most, checks
          whether {brand} is on each cited page, researches how to get onto each site and plans what to do for every
          prompt. It only runs when you click the button, and site research is saved, so a rebuild pays only for
          sites it hasn&apos;t researched.
          {newerCrawl && overview.crawl ? ` A newer crawl (${crawlDay(overview.crawl.startedAt)}) is available, and a rebuild uses it.` : ""}
        </p>
        {failed && !running && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            The last build didn&apos;t finish ({crawlDay(failed.createdAt)}, {money(failed.costUsd)} spent): {failed.error}
          </div>
        )}
        <OutreachBuildPanel
          clientId={id}
          label={complete ? "Rebuild Outreach Plan" : failed ? "Try again" : "Build Outreach Plan"}
          running={running}
          initialProgress={(latest?.progress as { step: string; done?: number; total?: number } | null) ?? null}
          targets={overview.targets.length}
          sitesToResearch={overview.sitesToResearch}
          promptCount={overview.promptCount}
          estimatesReused={overview.estimatesReused}
          researchCost={overview.sitesToResearch * COST_PER_SITE}
          estimateCost={overview.promptCount * COST_PER_PROMPT}
          pageCheckCost={COST_PAGE_CHECKS}
          costEstimate={overview.costEstimate}
          disabledReason={disabledReason}
        />
        {plan && !running && blocked.length > 0 && (
          <OutreachRecheckPanel
            clientId={id}
            brand={brand}
            clientHost={siteDomain(client.domain) ?? ""}
            namedBrands={plan.named_brands ?? []}
            pages={blocked}
            lastRecheck={
              plan.recheck
                ? `${crawlDay(new Date(plan.recheck.at))}: Chrome loaded ${plan.recheck.loaded} of ${plan.recheck.applied} pages, and ${brand} is listed on ${plan.recheck.listed}`
                : null
            }
          />
        )}
      </section>

      {plan && (
        <>
          <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
            The outside sites AI answers cite most, and how {brand} can get onto each one. Every cited page was checked
            for whether {brand} is already on it (through Google&apos;s copy of the page where a site blocks automated
            visits), and every site was researched for its real ways in. Each route is labeled Free or Paid, then by
            type. Costs and deadlines appear only where a linked source confirms them, and a route whose fee
            couldn&apos;t be confirmed is labeled Paid and marked &ldquo;Fee not confirmed&rdquo;. Two actions create a
            new page for AI to cite: a page on {brand}&apos;s own site answering the question, and a Top 10 article
            placed on a high-authority publication. Priority balances what AI cites now against what a new page could
            do.
          </p>

          <section className="mb-8">
            <h2 className={sectionTitle}>Routes at a Glance</h2>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {plan.groups.map((g) => (
                <div key={g.key} className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="text-sm font-medium text-zinc-950 dark:text-zinc-50">{g.label}</div>
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {g.domains.length} site{g.domains.length !== 1 ? "s" : ""}, cited on {g.prompt_count} of {total} prompts
                  </div>
                  <div className="mt-1 text-xs text-zinc-600 [overflow-wrap:anywhere] dark:text-zinc-300">{g.domains.join(", ")}</div>
                </div>
              ))}
            </div>
          </section>

          {ranked.length > 0 && (
            <section className="mb-8">
              <h2 className={sectionTitle}>Priority Order</h2>
              <p className={note}>
                Priority weighs <strong>Existing</strong> and <strong>Potential</strong>{" "}
                {Math.round(plan.existing_weight * 100)}/{Math.round((1 - plan.existing_weight) * 100)}.{" "}
                <strong>Existing</strong> is what AI cites today: how many of the {total} prompts cite the site, weighed
                against how open its best route is. For {brand}&apos;s own page it counts the prompts whose answers
                already cite a competitor&apos;s own page; for a placed article, the prompts whose answers already cite
                a best-of list on a third-party site. <strong>Potential</strong> is what a new page could do: the share
                of prompts likely to move into the top 3 once the page exists, from a rate of{" "}
                {pct(plan.rates.own.low)} to {pct(plan.rates.own.high)} for a page on {brand}&apos;s own site (track
                record for GEO content pages)
                {plan.rates.list
                  ? ` and ${pct(plan.rates.list.low)} to ${pct(plan.rates.list.high)} for a placed Top 10 article (${plan.rates.list.source === "tool" ? "the tool's estimate" : "set rate"})`
                  : ""}
                , each adjusted for how much a prompt&apos;s answers rely on that kind of page. Getting onto a page AI
                already cites adds no new page, so those sites have Existing only.
                {plan.rates.list?.reason ? ` Why the placed-article estimate: ${plan.rates.list.reason}` : ""}
              </p>
              <div className={tableWrap}>
                <table className="w-full text-sm">
                  <thead className={thead}>
                    <tr>
                      <th className="px-3 py-2 font-medium">#</th>
                      <th className="px-3 py-2 font-medium">Action</th>
                      <th className="px-3 py-2 font-medium">Cited On</th>
                      <th className="px-3 py-2 font-medium">Best Route</th>
                      <th className="px-3 py-2 font-medium">On the Page Today</th>
                      <th className="px-3 py-2 text-center font-medium">Existing</th>
                      <th className="px-3 py-2 text-center font-medium">Potential</th>
                      <th className="px-3 py-2 text-center font-medium">Priority</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    {ranked.map(({ num, lever, site }) => (
                      <tr key={num} className="align-top">
                        <td className="px-3 py-2 tabular-nums">{num}</td>
                        {lever ? (
                          <>
                            <td className="px-3 py-2">
                              <div className="font-medium text-zinc-950 dark:text-zinc-50">{lever.domain}</div>
                              <div className="text-xs text-zinc-500 dark:text-zinc-400">{lever.subtitle}</div>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {lever.prompt_count} of {total} prompts
                              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                                {lever.lever === "own" ? "cite competitor pages" : "cite third-party lists"}
                              </div>
                            </td>
                            <td className="px-3 py-2">{lever.label}</td>
                            <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">New page</td>
                            <td className="px-3 py-2 text-center"><Tier tier={lever.existing_tier} /></td>
                            <td className="px-3 py-2 text-center"><Tier tier={lever.potential_tier} /></td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-2">
                              <div className="font-medium text-zinc-950 dark:text-zinc-50">{site!.domain}</div>
                              <div className="text-xs text-zinc-500 dark:text-zinc-400">{site!.research.site_type_label}</div>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {site!.prompt_count} of {total} prompts
                              <div className="text-xs text-zinc-500 dark:text-zinc-400">{site!.citations} citations</div>
                            </td>
                            <td className="px-3 py-2">
                              {site!.research.primary_label}
                              {site!.research.competitor_owned && (
                                <div className="text-xs text-zinc-500 dark:text-zinc-400">competitor-owned</div>
                              )}
                            </td>
                            <td className="px-3 py-2"><OnPage s={site!} /></td>
                            <td className="px-3 py-2 text-center"><Tier tier={site!.existing_tier} /></td>
                            <td className="px-3 py-2 text-center text-xs text-zinc-400 dark:text-zinc-500">n/a</td>
                          </>
                        )}
                        <td className="px-3 py-2 text-center"><Tier tier={(lever ?? site)!.tier} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {ownPages.length > 0 && (
            <section className="mb-8">
              <h2 className={sectionTitle}>Answer With Your Own Page</h2>
              <p className={note}>
                These cited pages are competitors&apos; own lists and service pages. A rival rarely adds another firm to
                its own list, so the realistic answer is a stronger page on {brand}&apos;s own site, answering the same
                question, for AI platforms to cite.
                {ownLever ? ` They are the pages to answer first under action #${ownLever.num}.` : ""}
              </p>
              <div className={tableWrap}>
                <table className="w-full text-sm">
                  <thead className={thead}>
                    <tr>
                      {!ownLever && <th className="px-3 py-2 font-medium">#</th>}
                      <th className="px-3 py-2 font-medium">Site</th>
                      <th className="px-3 py-2 font-medium">Cited On</th>
                      <th className="px-3 py-2 font-medium">Page AI Platforms Cite</th>
                      <th className="px-3 py-2 font-medium">What to Publish</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    {ownPages.map((s) => (
                      <tr key={s.domain} className="align-top">
                        {!ownLever && <td className="px-3 py-2 tabular-nums">{numOf.get(s.domain)}</td>}
                        <td className="px-3 py-2">
                          <div className="font-medium text-zinc-950 dark:text-zinc-50">{s.domain}</div>
                          {s.research.competitor_owned && <div className="text-xs text-zinc-500 dark:text-zinc-400">competitor-owned</div>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {s.prompt_count} of {total}
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">{s.citations} citations</div>
                        </td>
                        <td className="min-w-[14rem] px-3 py-2">
                          {s.top_title || "untitled"}
                          <div className="text-xs">
                            <ExtLink url={s.top_url} />
                          </div>
                        </td>
                        <td className="min-w-[16rem] px-3 py-2">
                          <Prose text={s.research.next_step} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {skipped.length > 0 && (
            <p className="mb-8 text-sm text-zinc-600 dark:text-zinc-400">
              <strong>Not pursued:</strong>{" "}
              {skipped.map((s, i) => (
                <Fragment key={s.domain}>
                  {s.domain} (<Prose text={s.research.next_step || s.research.error || "no workable route"} />)
                  {i < skipped.length - 1 ? "; " : ""}
                </Fragment>
              ))}
            </p>
          )}

          {plan.prompts.length > 0 && (
            <section className="mb-8">
              <h2 className={sectionTitle}>Prompt Action Plan</h2>
              <p className={note}>
                What to do for each tracked prompt, drawn from the priority order above. Cited sites that share a route
                are combined into one action. Every prompt where {brand} isn&apos;t in the top 3 also gets the two
                actions that create a new page. Actions are listed in priority order for the prompt, so the first is
                the prompt&apos;s top move. Competitor-owned lists appear only as pages to answer with {brand}&apos;s
                own page. <strong>Comparable Firms Today</strong> shows where firms like {brand} rank in this
                prompt&apos;s answers now; it describes the answers today, not a forecast. <strong>AI Estimate</strong>{" "}
                is an AI model&apos;s judgment of where {brand} would likely land if it completed that action alone and
                AI kept citing the same sources; for the two new-page actions, it gives the chance of the top 3 once AI
                cites that page. Both are estimates, not measured results.
              </p>
              <div className={tableWrap}>
                <table className="w-full text-sm">
                  <thead className={thead}>
                    <tr>
                      <th className="px-3 py-2 font-medium">Prompt</th>
                      <th className="px-3 py-2 font-medium">Recommended Action</th>
                      <th className="px-3 py-2 font-medium">Comparable Firms Today</th>
                      <th className="px-3 py-2 font-medium">AI Estimate</th>
                    </tr>
                  </thead>
                  {[...promptGroups.entries()].map(([category, prompts]) => (
                    <Fragment key={category}>
                      <tbody>
                        <tr>
                          <td colSpan={4} className="bg-zinc-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500">
                            {CATEGORY_LABEL[category] ?? category}
                          </td>
                        </tr>
                      </tbody>
                      {prompts.map((p) => (
                        <tbody key={p.prompt} className="border-t border-zinc-200 dark:border-zinc-800">
                          {p.recommendations.map((rec, i) => (
                            <tr key={i} className="align-top">
                              {i === 0 && (
                                <td rowSpan={p.recommendations.length} className="min-w-[12rem] px-3 py-2 text-zinc-700 dark:text-zinc-300">
                                  {p.prompt}
                                </td>
                              )}
                              <td className="min-w-[14rem] px-3 py-2">
                                <span className={rec.fee === "Free" ? "font-medium text-emerald-700 dark:text-emerald-400" : "font-medium text-amber-700 dark:text-amber-400"}>
                                  {rec.fee}:
                                </span>{" "}
                                {rec.text}
                              </td>
                              <td className="min-w-[12rem] px-3 py-2">
                                {rec.comparable?.text}
                                {rec.comparable?.detail && <div className="text-xs text-zinc-500 dark:text-zinc-400">{rec.comparable.detail}</div>}
                              </td>
                              <td className="min-w-[12rem] px-3 py-2">
                                {rec.potential_text ? (
                                  <>
                                    <div className="text-xs text-zinc-500 dark:text-zinc-400">If AI cites the new page:</div>
                                    <span className="font-medium">{rec.potential_text.text}</span>
                                    {rec.potential_text.detail && <div className="text-xs text-zinc-500 dark:text-zinc-400">{rec.potential_text.detail}</div>}
                                  </>
                                ) : rec.estimate ? (
                                  <>
                                    <span
                                      className={
                                        rec.estimate.estimate === "top_3"
                                          ? "font-medium text-emerald-700 dark:text-emerald-400"
                                          : rec.estimate.estimate === "named"
                                            ? "font-medium text-amber-700 dark:text-amber-400"
                                            : "font-medium text-zinc-600 dark:text-zinc-400"
                                      }
                                    >
                                      {rec.estimate.label}
                                    </span>
                                    {rec.estimate.reason && <div className="text-xs text-zinc-500 dark:text-zinc-400">{rec.estimate.reason}</div>}
                                  </>
                                ) : (
                                  <span className="text-zinc-400 dark:text-zinc-500">Estimate unavailable</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      ))}
                    </Fragment>
                  ))}
                </table>
              </div>
            </section>
          )}

          {targets.length > 0 && (
            <section className="mb-8">
              <h2 className={sectionTitle}>Outreach Plan by Site</h2>
              <div className="mt-2 space-y-4">
                {targets.map(({ num, site }) => (
                  <SiteCard key={site!.domain} s={site!} num={num} brand={brand} total={total} />
                ))}
              </div>
            </section>
          )}

          <section className="mb-4 space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
            <p>
              <strong>Before reaching out.</strong> Build one submission package and reuse it for every site: a short
              description written in the category&apos;s own terms, three case studies with measurable results, client
              references, leadership bios and any awards or other recognition. Match each site&apos;s own service and
              industry labels when you send it. Pitch each site on the specific gap in its page, naming who it lists
              and why {brand} belongs beside them, rather than a general request to be added.
            </p>
            <p>
              <strong>Paying for placement.</strong> Pay only for placement the site labels as paid or sponsored.
              Buying a spot in a list that presents itself as an independent ranking, without disclosure, runs against
              the FTC&apos;s rules on endorsements and native advertising, and it undoes the credibility the listing was
              supposed to add.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
