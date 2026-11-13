"""
Outreach Plan for the portal's Outreach Plan tab: for the third-party sites a client's
Live Search crawl cites most, how the client can get onto each one, and what to do per
prompt. Ported from geo-citation-checker (outreach_planner.py, potential.py,
action_estimates.py and the wiring in geo_citation_checker.py) on 2026-11-13; the rules,
prompts and scoring are the same, so a site reads the same in both tools.

Differences from the standalone tool:
  - No browser fallback for listing checks: Vercel functions can't open a real Chrome
    window. A page that refuses plain requests goes to Google's copy of it (Serper),
    else "couldn't check". The planned helper app re-checks those (phase 4).
  - Nothing is cached in files. The portal stores research per client and site
    (OutreachSite) and passes it back in; estimates and the placed-list rate come back
    with their signatures so the next build can reuse them (OutreachPlan.plan).
  - Every paid call reports its own cost, from the provider's usage counts.

Stateless: api/outreach.py exposes these functions; src/lib/outreach.ts orchestrates a
build and stores the results.
"""

import functools
import hashlib
import json
import os
import re
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlparse, urlsplit, urlunsplit

import anthropic
import httpx
from bs4 import BeautifulSoup

RESEARCH_MODEL = "claude-opus-5-5"
# USD list prices (Nov 2026): Opus 5.5 per million tokens, and per search.
_PRICE = {"in": 4.00, "out": 20.00, "cache_read": 0.20, "cache_write": 5.00}
WEB_SEARCH_PRICE = 10.00 / 1000
SERPER_PRICE = 1.00 / 1000

PLATFORM_LABELS = {"CHATGPT": "ChatGPT", "CLAUDE": "Claude", "GEMINI": "Gemini", "PERPLEXITY": "Perplexity"}


def _usage_cost(resp) -> float:
    u = getattr(resp, "usage", None)
    if u is None:
        return 0.0
    n = lambda name: getattr(u, name, 0) or 0  # noqa: E731
    tools = getattr(u, "server_tool_use", None)
    searches = (getattr(tools, "web_search_requests", 0) or 0) if tools is not None else 0
    return (n("input_tokens") * _PRICE["in"] + n("output_tokens") * _PRICE["out"]
            + n("cache_read_input_tokens") * _PRICE["cache_read"]
            + n("cache_creation_input_tokens") * _PRICE["cache_write"]) / 1_000_000 + searches * WEB_SEARCH_PRICE


def domain_of(url: str) -> str:
    """Host without scheme or "www.", from a URL or a bare domain."""
    if "://" not in url:
        url = f"https://{url}"
    netloc = urlparse(url).netloc.lower()
    return netloc[4:] if netloc.startswith("www.") else netloc


# ── Route types and scoring (outreach_planner.py) ─────────────────────────────

# (label, short name, how open the route is for the priority score, 1.0 = you control it).
# Every label is shown after the route's fee, "Free: " or "Paid: ", except "Don't pursue".
ROUTE_TYPES = {
    "awards":              ("Award entry", "awards", 0.7),
    "data_ranking":        ("Data-based ranking", "data ranking", 0.8),
    "review_ranking":      ("Review-based ranking", "reviews", 0.8),
    "submission":          ("Submission", "submission", 0.9),
    "profile":             ("Profile", "profile", 1.0),
    "sponsored_placement": ("Sponsored placement", "placement", 1.0),
    "editorial_pitch":     ("Editor pitch", "pitch", 0.5),
    "contributed_content": ("Contributed article", "article", 0.5),
    "own_content":         ("Your own page", "own page", 0.9),
    "placed_list":         ("Placed Top 10 article", "placed list", 1.0),
    "skip":                ("Don't pursue", "skip", 0.0),
}
ROUTE_WEIGHT = {key: weight for key, (_, _, weight) in ROUTE_TYPES.items()}
FEES = ("free", "paid")
FIXED_FEE = {"sponsored_placement": "paid", "editorial_pitch": "free", "own_content": "free", "placed_list": "paid"}
# Bump when the research reply's shape changes: older research is researched again.
RESEARCH_SCHEMA = 3
_NO_COST_RE = re.compile(r"(?i)\s*(not confirmed|unknown|n/?a|none|not (?:publicly )?(?:listed|available|stated))\.?\s*")


def route_label(rtype: str, fee: str | None, short: bool = False) -> str:
    label = ROUTE_TYPES[rtype][1 if short else 0]
    if rtype == "skip":
        return label.capitalize()
    fee = FIXED_FEE.get(rtype) or fee or "paid"
    return f"{fee.capitalize()}: {label}"


COMPETITOR_OWNED_FACTOR = 0.3
ALREADY_LISTED_FACTOR = 0.5
SITE_TYPE_FACTOR = {"encyclopedia": 0.3}

_OUTREACH_TYPES = [t for t in ROUTE_TYPES if t not in ("own_content", "placed_list", "skip")]
GROUP_ORDER = (
    [(f"{fee}_{t}", route_label(t, fee)) for fee in FEES for t in _OUTREACH_TYPES
     if FIXED_FEE.get(t, fee) == fee]
    + [("competitor", "Competitor-owned list, low odds"), ("own", route_label("own_content", "free")),
       ("skip", route_label("skip", None)), ("unresearched", "Couldn't research")]
)

ROUTE_ACTIONS = {
    "awards": "Enter awards at {sites}",
    "data_ranking": "Submit figures to the ranking at {sites}",
    "review_ranking": "Collect client reviews on {sites}",
    "submission": "Submit to {sites}",
    "profile": "Claim or complete a profile on {sites}",
    "sponsored_placement": "Buy placement on {sites}",
    "editorial_pitch": "Pitch editors at {sites}",
    "contributed_content": "Contribute an article to {sites}",
    "own_content": "Build your own page to compete with {sites}",
    "placed_list": "Place a Top 10 article on {sites}",
}


def _join_names(names: list[str]) -> str:
    """"a", "a & b", "a, b & c" (no Oxford comma, client copy style)."""
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " & " + names[-1]


def group_prompt_actions(sites: list[dict], listed: set[str] = frozenset()) -> list[dict]:
    """One prompt's ranked plan sites collapsed into one recommendation per route (fee + type)."""
    groups: dict[tuple, list[dict]] = {}
    for s in sorted(sites, key=lambda s: s["num"]):
        r = s["research"]
        fee = FIXED_FEE.get(r["primary_route"]) or r.get("primary_fee") or "paid"
        groups.setdefault((fee, r["primary_route"]), []).append(s)

    def name(site):
        already = site["kind"] == "outreach" and site["domain"] in listed
        return site["domain"] + (" (already listed)" if already else "")

    return [{"fee": fee.capitalize(),
             "text": ROUTE_ACTIONS[rtype].format(sites=_join_names([name(m) for m in members])),
             "nums": [m["num"] for m in members],
             "tier": members[0]["tier"],
             "rtype": rtype,
             "domains": [m["domain"] for m in members],
             "existing": max(m["score"] for m in members),
             "potential": 0.0}
            for (fee, rtype), members in groups.items()]


SITE_TYPES = [
    "directory_or_marketplace", "editorial_publication", "trade_media", "awards_or_rankings_program",
    "industry_association", "review_platform", "competitor_content", "company_own_page",
    "encyclopedia", "social_or_user_generated", "other",
]


# ── Page check ────────────────────────────────────────────────────────────────

REFUSALS_BEFORE_SKIP = 4
_BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
               "Chrome/130.0 Safari/537.36")
_BLOCK_MARKERS = re.compile(r"just a moment|verify you are human|access denied|attention required|"
                            r"are you a robot|checking your browser|enable javascript and cookies", re.I)


def _looks_blocked(html: str) -> bool:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ") if soup.title else ""
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    visible = re.sub(r"\s+", " ", soup.get_text(" ")).strip()
    return len(visible) < 300 or bool(_BLOCK_MARKERS.search(title + " " + visible[:1500]))


def clean_url(url: str) -> str:
    """A cited URL minus tracking parameters and fragment ("?utm_source=openai")."""
    parts = urlsplit(url.strip())
    query = "&".join(q for q in parts.query.split("&") if q and not q.lower().startswith("utm_"))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


def _page_key(url: str) -> str:
    parts = urlsplit(clean_url(url))
    return (parts.netloc.lower().removeprefix("www.") + parts.path.rstrip("/")
            + (f"?{parts.query}" if parts.query else ""))


def _fetch_http(url: str) -> tuple[str | None, str]:
    """(html, "http"), or (None, reason)."""
    try:
        r = httpx.get(url, headers={"User-Agent": _BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"},
                      timeout=15, follow_redirects=True)
        ctype = r.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if r.status_code == 200 and ctype and "html" not in ctype:
            return None, f"not a web page ({ctype})"
        if r.status_code == 200 and not _looks_blocked(r.text):
            return r.text, "http"
        return None, f"HTTP {r.status_code}"
    except httpx.HTTPError as e:
        return None, type(e).__name__
    except Exception as e:   # a body the HTML parser can't read
        return None, f"unreadable page ({type(e).__name__})"


def _google_check(url: str, brand: str, counter: list) -> dict | None:
    """Google's copy of a page no plain request could load, through Serper. Says whether the
    brand is on it; can't give a position or the other firms. None when it can't tell."""
    key = os.environ.get("SERPER_API_KEY")
    if not key:
        return None
    parts = urlsplit(url)
    scope = (parts.netloc.lower().removeprefix("www.") + parts.path).rstrip("/")
    want = _page_key(url)

    def search(query):
        r = httpx.post("https://google.serper.dev/search", json={"q": query, "num": 10}, timeout=30,
                       headers={"X-API-KEY": key, "Content-Type": "application/json"})
        counter.append(1)
        r.raise_for_status()
        return r.json().get("organic", [])

    found = {"status": "indexed", "fetched_with": "google", "position": None, "competitors_on_page": [],
             "competitors_found": 0}
    try:
        hit = next((h for h in search(f'site:{scope} "{brand}"') if _page_key(h.get("link", "")) == want), None)
        if hit:
            if re.search(rf"\b{re.escape(brand)}\b", f"{hit.get('title', '')} {hit.get('snippet', '')}"):
                return {**found, "listed": True}
            return None
        if any(_page_key(h.get("link", "")) == want for h in search(f"site:{scope}")):
            return {**found, "listed": False}
    except (httpx.HTTPError, ValueError):
        return None
    return None


def _is_site_itself(name: str, site_domain: str) -> bool:
    """Either name contains the other: "Clutch" on clutch.co, "O'Dwyer's" on odwyerpr.com."""
    site_key = re.sub(r"[^a-z0-9]", "", site_domain.split(".")[0])
    dotless = re.sub(r"[^a-z0-9]", "", site_domain.rsplit(".", 1)[0]) if site_domain.count(".") == 1 else site_key
    trimmed = re.sub(r"(pr|media|hq|inc|group|news|mag)$", "", site_key)
    nk = re.sub(r"[^a-z0-9]", "", name.lower())
    if len(nk) < 4:
        return False
    keys = {site_key, dotless, re.sub(r"[^a-z0-9]", "", site_domain)} | ({trimmed} if len(trimmed) >= 5 else set())
    return any(k and (k in nk or nk in k) for k in keys)


def _check_page(html: str, how: str, brand: str, client_host: str, named_brands: set[str], site_domain: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    links = " ".join(a.get("href", "") for a in soup.find_all("a"))
    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.decompose()
    text = re.sub(r"\s+", " ", soup.get_text(" "))
    # Case-sensitive on purpose: a brand that is also a word is capitalized when it's a listed firm.
    listed = bool(re.search(rf"\b{re.escape(brand)}\b", text)) or client_host in links.lower()
    found = []
    for name in named_brands:
        if len(name) < 3 or name.casefold() == brand.casefold():
            continue
        if _is_site_itself(name, site_domain):
            continue
        if " " not in name and re.search(rf"\b{re.escape(name.lower())}\b", text):
            continue
        m = re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", text)
        if m:
            found.append((m.start(), name))
    found.sort()
    client_match = re.search(rf"\b{re.escape(brand)}\b", text)
    position = 1 + sum(1 for start, _ in found if start < client_match.start()) if client_match else None
    return {"status": "checked", "fetched_with": how, "listed": listed, "position": position,
            "competitors_on_page": [name for _, name in found[:8]], "competitors_found": len(found)}


def check_pages(urls_by_site: dict[str, list[str]], brand: str, client_host: str,
                named_brands: set[str]) -> tuple[dict[str, dict[str, dict]], float]:
    """A listing check for every cited page: ({site: {url: check}}, Serper cost). Plain HTTP in
    parallel, then Google's copy of pages that refuse it."""
    site_of = {u: site for site, urls in urls_by_site.items() for u in urls}
    urls = list(site_of)
    # 16 pages at a time overall, but at most 2 per host: a crawl can cite 100+ pages on one
    # site (psychologytoday.com), and a burst from one address gets every one of them a 403.
    hosts = {u: urlsplit(u).netloc.lower() for u in urls}
    gates = {h: threading.Semaphore(2) for h in set(hosts.values())}
    # A host that refuses its first few pages and loads none is refusing this server: its
    # other pages go straight to Google's copy instead of waiting out a refusal each.
    tally = {h: [0, 0] for h in gates}   # [refusals, pages loaded]
    lock = threading.Lock()

    def fetch(u):
        h = hosts[u]
        with gates[h]:
            with lock:
                if tally[h][0] >= REFUSALS_BEFORE_SKIP and not tally[h][1]:
                    return None, "the site refused the server's first few requests"
            html, how = _fetch_http(u)
            with lock:
                if html is not None:
                    tally[h][1] += 1
                elif not how.startswith(("HTTP 404", "HTTP 410", "not a web page")):
                    tally[h][0] += 1
            return html, how

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = dict(zip(urls, pool.map(fetch, urls)))
    searches: list = []
    checks = {site: {} for site in urls_by_site}
    pending = []
    for u in urls:
        html, how = results[u]
        if html is not None:
            try:
                checks[site_of[u]][u] = _check_page(html, how, brand, client_host, named_brands, site_of[u])
                continue
            except Exception as e:
                how = f"unreadable page ({type(e).__name__})"
        pending.append((u, how))
    # Google's copy of every page that wouldn't load, 8 searches at a time.
    with ThreadPoolExecutor(max_workers=8) as pool:
        found = list(pool.map(lambda item: _google_check(item[0], brand, searches), pending))
    for (u, how), check in zip(pending, found):
        checks[site_of[u]][u] = check or {"status": "unreachable", "reason": how}
    return checks, len(searches) * SERPER_PRICE


# ── Research ──────────────────────────────────────────────────────────────────

_RESEARCH_PROMPT = """You are planning third-party outreach for {brand} ({client_domain}). AI assistants answering
buyer questions in {brand}'s category keep citing pages on {site}. {brand} wants to know how to get onto them.

What this site is cited for (from {brand}'s own AI-visibility run):
- Cited {citations} times across {prompt_count} of {total_prompts} tracked buyer prompts, for example:
{prompt_examples}
- Most-cited pages on the site:
{pages}
- Live check of every cited page on the site:
{page_check}

Research {site} with web search: who publishes it, whether the publisher competes with {brand}, and every real
route a company like {brand} has onto the cited page or the site (paid listing or sponsorship, a submission or
"get listed" form, an awards or rankings entry, client reviews, claiming a profile, contributed content, pitching
the editor). Check the site's own advertise, submit, awards, methodology or about pages where they exist.

Route types, so the same kind of route gets the same type on every site:
- awards: entering awards or "best agencies" / "agency of the year" picks, where judges choose among entrants.
- data_ranking: a ranking ordered by figures companies submit, such as fee income, revenue or headcount.
- review_ranking: a list, score or ranking built from client reviews, including ones with no entry form of
  their own.
- submission: a form, application or draft the site reviews and publishes once it meets stated criteria, with no
  judging or ordering against other entrants (a directory "get listed" form, a member directory, a Wikipedia draft).
- profile: claiming or completing a company profile on the site.
- sponsored_placement: paying for a listing, sponsorship, featured spot or advertising.
- editorial_pitch: pitching an editor or writer for coverage or a spot in a list.
- contributed_content: a guest article, byline or sponsored post on the site.
List only routes the site actually offers. When a route doesn't exist (no submission form, no entry), leave it out
rather than listing it to say so.
Every route also gets a fee: "paid" if taking it costs anything at all (entry fee, processing fee, a required
listing or membership, sponsorship), "free" if it costs nothing, or "unknown". For award, ranking, submission and
profile routes, open the entry instructions, entry form or terms (PDFs included) and look for fees before deciding.
If you couldn't see them, the fee is "unknown": never answer "free" just because no fee turned up.

Today is {today}.

Rules:
- Only state a cost, price, fee or deadline if you found it on a page, and put that page's URL in source_url.
  Never estimate or recall a number from memory. If pricing isn't public, say "pricing on request" with no number.
- Write cost as a short readable phrase built from the source's figures ("$675 to $935 per entry", "Free"),
  not a pasted fragment of the page.
- Compare every deadline with today's date. If it has passed, say so in the deadline field and point next_step
  at the next cycle; never tell the reader to meet a deadline that is already over.
- This text goes straight into a client report: write in a neutral third-person voice. Never write "I", "my
  research" or "my searches", and never mention search tools or their limits. Say "not confirmed" instead.
- Keep each route summary under 35 words.
- If the cited page is a company's own service page, FAQ or blog post about its own offer rather than a list of
  providers, the route is "own_content": {brand} should publish a stronger page of its own on that question.
- If paying would buy a position in a list that presents itself as independent without disclosure, don't
  recommend it; say so.
- next_step must be one concrete action naming the specific page or program, not generic advice.
- Plain American English. No em dashes. No Oxford comma before "and" or "or" in a list.

Reply with JSON only, no prose before or after:
{{
  "site_type": one of {site_types},
  "who_runs_it": "one sentence: who publishes it and whether they sell the same services as {brand}",
  "competitor_owned": true or false,
  "routes": [
    {{"type": one of {route_types},
      "fee": "free", "paid" or "unknown",
      "summary": "one sentence on what this route gets you and what it doesn't",
      "cost": "short readable phrase from the source's figures, or null",
      "deadline": "the date from the source, noting if it has passed, or null",
      "source_url": "the page that confirms this route, or null"}}
  ],
  "primary_route": the single best route type for {brand}, or "own_content" or "skip",
  "next_step": "one concrete sentence",
  "why": "one sentence on why this is the best route",
  "evidence": "confirmed" if routes come from the site's own pages, "partial", or "unverified"
}}"""


def _client():
    return anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def _parse_json(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def _clean_research(r: dict) -> dict:
    """Enforce the prompt's rules instead of trusting them: unsourced costs and deadlines are
    removed, unknown values normalized, and an unknown fee is labeled Paid and flagged."""
    routes = []
    for route in r.get("routes") or []:
        rtype = route.get("type")
        if rtype not in ROUTE_TYPES or rtype in ("own_content", "placed_list", "skip"):
            continue
        src = route.get("source_url") or None
        if src and not str(src).startswith("http"):
            src = None
        fee_unknown = rtype not in FIXED_FEE and route.get("fee") not in FEES
        fee = FIXED_FEE.get(rtype) or ("paid" if fee_unknown else route["fee"])
        cost = route.get("cost") if src else None
        if cost and _NO_COST_RE.fullmatch(cost):
            cost = None
        routes.append({
            "type": rtype, "fee": fee, "fee_unknown": fee_unknown, "label": route_label(rtype, fee),
            "summary": route.get("summary") or "", "cost": cost,
            "deadline": route.get("deadline") if src else None, "source_url": src,
        })
    primary = r.get("primary_route")
    if primary not in ROUTE_TYPES or primary == "placed_list":
        primary = routes[0]["type"] if routes else "skip"
    primary_fee = next((x["fee"] for x in routes if x["type"] == primary), None)
    site_type = r.get("site_type") if r.get("site_type") in SITE_TYPES else "other"
    return {
        "schema": RESEARCH_SCHEMA,
        "site_type": site_type,
        "site_type_label": site_type.replace("_", " ").capitalize(),
        "who_runs_it": r.get("who_runs_it") or "",
        "competitor_owned": bool(r.get("competitor_owned")),
        "routes": routes,
        "primary_route": primary,
        "primary_fee": FIXED_FEE.get(primary) or primary_fee,
        "primary_label": route_label(primary, primary_fee),
        "primary_short": route_label(primary, primary_fee, short=True),
        "next_step": r.get("next_step") or "",
        "why": r.get("why") or "",
        "evidence": r.get("evidence") if r.get("evidence") in ("confirmed", "partial", "unverified") else "unverified",
    }


def _url_list(urls: list[str], cap: int = 12) -> str:
    return ", ".join(urls[:cap]) + (f" and {len(urls) - cap} more" if len(urls) > cap else "")


def _listing_text(brand: str, url_order: list[str], pages: dict[str, dict]) -> str:
    listed = [u for u in url_order if pages.get(u, {}).get("listed")]
    missing = [u for u in url_order if pages.get(u, {}).get("status") in ("checked", "indexed")
               and not pages[u].get("listed")]
    unknown = [u for u in url_order if u not in listed and u not in missing]
    lines = []
    if listed:
        def where(u):
            pos = pages[u].get("position")
            return f" (after {pos - 1} of the other firms named in the run's answers)" if pos and pos > 1 else ""
        lines.append(f"  - {brand} IS already listed on: " + "; ".join(f"{u}{where(u)}" for u in listed[:12])
                     + (f" and {len(listed) - 12} more" if len(listed) > 12 else ""))
    if missing:
        lines.append(f"  - {brand} is NOT on: {_url_list(missing)}")
    if unknown:
        lines.append(f"  - Couldn't load {_url_list(unknown)}; check {brand}'s listing status there yourself.")
    top = pages.get(url_order[0], {}) if url_order else {}
    if top.get("status") == "checked":
        on_page = ", ".join(top["competitors_on_page"]) or "none of the firms named in the run's answers"
        lines.append(f"  - Firms from the run's answers on the most-cited page: {on_page}.")
    if listed:
        lines.append(f"  - Where {brand} is already listed, the goal is a better position or a stronger profile, "
                     f"not getting added.")
    return "\n".join(lines)


def _carry_forward_fees(research: dict, earlier: dict | None, earlier_at: str | None) -> None:
    """Fills each unconfirmed fee from this client's earlier research of the same site and route
    type that confirmed it (a fresh research pass can fail to confirm what an earlier one did)."""
    if not earlier:
        return
    for route in research.get("routes", []):
        if not route.get("fee_unknown"):
            continue
        prior = next((r for r in earlier.get("routes", [])
                      if r.get("type") == route["type"] and not r.get("fee_unknown") and r.get("fee") in FEES), None)
        if prior:
            when = ""
            if earlier_at:
                try:
                    when = datetime.fromisoformat(earlier_at.replace("Z", "+00:00")).strftime("%B %d, %Y")
                except ValueError:
                    when = ""
            route.update(fee=prior["fee"], fee_unknown=False, label=route_label(route["type"], prior["fee"]),
                         fee_from={"date": when, "source_url": prior.get("source_url")})
    primary = research.get("primary_route")
    if primary and primary not in ("own_content", "skip"):
        fee = next((r["fee"] for r in research.get("routes", []) if r["type"] == primary), None)
        research.update(primary_fee=FIXED_FEE.get(primary) or fee, primary_label=route_label(primary, fee),
                        primary_short=route_label(primary, fee, short=True))


def _listed_urls(pages: dict[str, dict]) -> list[str]:
    return sorted(u for u, c in pages.items() if c.get("listed"))


def research_site(brand: str, client_domain: str, site: str, stats: dict, total_prompts: int,
                  pages: dict[str, dict], earlier: dict | None = None, earlier_at: str | None = None,
                  model: str = RESEARCH_MODEL) -> tuple[dict, float]:
    """(research, cost). stats: {"citations", "prompts": [...], "urls": [[url, count], ...] most-cited
    first, "titles": {url: title}}. research is {"error": ...} when it failed."""
    url_order = [u for u, _ in stats["urls"]]
    examples = sorted(stats["prompts"])[:6]
    top_pages = [f"  - {stats['titles'].get(u) or '(untitled)'}: {u} (cited {n} times)" for u, n in stats["urls"][:3]]
    prompt = _RESEARCH_PROMPT.format(
        brand=brand, client_domain=client_domain, site=site, citations=stats["citations"],
        prompt_count=len(stats["prompts"]), total_prompts=total_prompts,
        prompt_examples="\n".join(f'  - "{p}"' for p in examples), pages="\n".join(top_pages),
        page_check=_listing_text(brand, url_order, pages),
        today=datetime.now(timezone.utc).strftime("%B %d, %Y"),
        site_types=" | ".join(SITE_TYPES), route_types=" | ".join(_OUTREACH_TYPES),
    )
    # web_fetch lets the model open entry instructions, forms and PDFs, which search
    # snippets rarely carry fees from (O'Dwyer's fee is only in its instructions PDF).
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 6},
             {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 5, "max_content_tokens": 20000}]
    cost, last_error = 0.0, None
    for _ in range(3):
        messages = [{"role": "user", "content": prompt}]
        try:
            resp = _client().messages.create(model=model, max_tokens=4000, tools=tools, messages=messages)
            cost += _usage_cost(resp)
            # A long server-tool session can pause before the answer; hand it back to continue.
            for _ in range(3):
                if resp.stop_reason != "pause_turn":
                    break
                messages = [messages[0], {"role": "assistant", "content": resp.content}]
                resp = _client().messages.create(model=model, max_tokens=4000, tools=tools, messages=messages)
                cost += _usage_cost(resp)
        except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
            last_error = str(e)
            continue
        parsed = _parse_json("".join(b.text for b in resp.content if b.type == "text"))
        if parsed:
            research = _clean_research(parsed)
            research["listing_basis"] = _listed_urls(pages)
            _carry_forward_fees(research, earlier, earlier_at)
            return research, cost
        last_error = "reply wasn't valid JSON"
    return {"error": last_error or "unknown error"}, cost


# ── Answer data ───────────────────────────────────────────────────────────────
# rows: [{"prompt", "category", "platforms": {PLATFORM: {"mentioned", "rank", "full_response",
#         "citations": [{"url", "title", "domain"}], "error"}}}], one per tracked prompt, in order.

def named_brands_from(extracted: list[list[str]], rows: list[dict]) -> set[str]:
    """Firm names to look for on cited pages: only names that literally appear in an answer, minus
    one-word names the answers also use as an ordinary lowercase word ("Profile")."""
    answer_text = "\n".join(c["full_response"] for row in rows for c in row["platforms"].values() if c["full_response"])
    prose = re.sub(r"https?://\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,6}\b", " ", answer_text)
    return {
        b for names in extracted for b in names
        if b and re.search(rf"(?<![\w-]){re.escape(b)}(?![\w-])", answer_text)
        and not (" " not in b and b != b.lower() and re.search(rf"\b{re.escape(b.lower())}\b", prose))
    }


def _answered_cells(row: dict, platforms: list[str]):
    for p in platforms:
        cell = row["platforms"].get(p)
        if cell and not cell.get("error") and cell.get("full_response"):
            yield p, cell


def site_stats(rows: list[dict], platforms: list[str], target_domains: list[str], client_host: str) -> dict:
    """{site: {"citations", "prompts" (prompt order), "urls" [[clean url, count]] most-cited first,
    "titles"}} for each target site any answer cites."""
    prompts = [row["prompt"] for row in rows]
    raw: dict[str, dict] = {}
    for row in rows:
        for _, cell in _answered_cells(row, platforms):
            for c in cell["citations"]:
                # The stored Citation.domain, not the URL's host: for an unresolved Gemini
                # redirect it is the site Gemini named rather than vertexaisearch.cloud.google.com.
                d = c["domain"]
                if d not in target_domains or d == client_host or d.endswith("." + client_host):
                    continue
                url = clean_url(c["url"])
                s = raw.setdefault(d, {"citations": 0, "prompts": set(), "urls": Counter(), "titles": {}})
                s["citations"] += 1
                s["prompts"].add(row["prompt"])
                s["urls"][url] += 1
                s["titles"].setdefault(url, c.get("title") or "")
    return {d: {"citations": s["citations"], "prompts": sorted(s["prompts"], key=prompts.index),
                "urls": [[u, n] for u, n in s["urls"].most_common()], "titles": s["titles"]}
            for d, s in raw.items()}


# ── Plan (outreach_planner.py) ────────────────────────────────────────────────

def _kind(research: dict) -> str:
    if "error" in research:
        return "unknown"
    if research["primary_route"] == "own_content":
        return "own_page"
    if research["primary_route"] == "skip":
        return "skip"
    return "outreach"


def priority_tier(score: float) -> str:
    return "High" if score >= 0.25 else "Medium" if score >= 0.08 else "Low"


def _priority(coverage: float, research: dict, listed_share: float) -> tuple[float, str]:
    kind = _kind(research)
    if kind in ("unknown", "skip"):
        return 0.0, kind.capitalize()
    score = coverage * ROUTE_WEIGHT[research["primary_route"]] * SITE_TYPE_FACTOR.get(research["site_type"], 1.0)
    if kind == "outreach":
        if research["competitor_owned"]:
            score *= COMPETITOR_OWNED_FACTOR
        score *= 1 - (1 - ALREADY_LISTED_FACTOR) * listed_share
    return round(score, 3), priority_tier(score)


def _plan_sites(stats: dict, target_domains: list[str], cache: dict, named_brands: set[str],
                prompts: list[str], total_prompts: int) -> dict:
    sites = [d for d in target_domains if d in stats]
    rows = []
    for site in sites:
        s, entry = stats[site], cache.get(site) or {}
        research = entry.get("research") or {"error": "not researched"}
        all_pages = entry.get("pages") or {}
        checks = {}
        for u, _ in s["urls"]:
            check = dict(all_pages.get(u) or {"status": "unreachable", "reason": "not checked"})
            if check.get("competitors_on_page"):
                check["competitors_on_page"] = [n for n in check["competitors_on_page"]
                                                if n in named_brands and not _is_site_itself(n, site)]
            checks[u] = check
        pages = [{"url": u, "title": s["titles"].get(u) or "", "count": n, **checks[u]} for u, n in s["urls"]]
        known = [p for p in pages if p["status"] in ("checked", "indexed")]
        listed_share = (sum(p["count"] for p in known if p["listed"]) / sum(p["count"] for p in known)
                        if known else 0.0)
        coverage = len(s["prompts"]) / total_prompts if total_prompts else 0
        score, tier = _priority(coverage, research, listed_share)
        if "error" in research:
            group = "unresearched"
        elif research["primary_route"] == "own_content":
            group = "own"
        elif research["primary_route"] == "skip":
            group = "skip"
        elif research["competitor_owned"]:
            group = "competitor"
        else:
            group = f"{research['primary_fee'] or 'paid'}_{research['primary_route']}"
        top_url = s["urls"][0][0]
        listed_now = _listed_urls({p["url"]: p for p in pages})
        rows.append({
            "domain": site, "group": group, "kind": _kind(research),
            "score": score, "existing_tier": tier, "tier": tier,
            "prompt_count": len(s["prompts"]), "citations": s["citations"], "prompts": s["prompts"],
            "top_url": top_url, "top_title": s["titles"].get(top_url) or "",
            "pages": pages, "checks": checks, "page_check": checks[top_url],
            "listing": {"listed": [p for p in known if p["listed"]], "missing": [p for p in known if not p["listed"]],
                        "unknown": [p for p in pages if p not in known], "total": len(pages)},
            # The research was told a different set of listed pages than today's checks found.
            "listing_changed": "error" not in research and research.get("listing_basis") is not None
                               and research["listing_basis"] != listed_now,
            "researched_at": entry.get("researched_at"),
            "research": research,
        })
    kind_order = {"outreach": 0, "own_page": 0, "skip": 1, "unknown": 2}
    rows.sort(key=lambda r: (kind_order[r["kind"]], -r["score"], -r["prompt_count"]))
    groups = []
    for key, label in GROUP_ORDER:
        members = [r for r in rows if r["group"] == key]
        if members:
            covered = set().union(*(set(r["prompts"]) for r in members))
            groups.append({"key": key, "label": label, "domains": [r["domain"] for r in members],
                           "prompt_count": len(covered)})
    return {"sites": rows, "groups": groups, "total_prompts": total_prompts, "model": RESEARCH_MODEL}


def rank_plan(plan: dict, levers: list[dict] = (), existing_weight: float = 1.0) -> dict:
    """Numbers one priority list: Existing (what AI cites today) against Potential (what a new
    page could do), weighted existing_weight / (1 - existing_weight)."""
    own_pages = [r for r in plan["sites"] if r["kind"] == "own_page"]
    for r in plan["sites"]:
        if r["kind"] in ("outreach", "own_page"):
            r["potential"], r["potential_tier"] = 0.0, None
            r["priority"] = round(existing_weight * r["score"], 3)
            r["tier"] = priority_tier(r["priority"])
        r.pop("num", None)
    for r in levers:
        r["priority"] = round(existing_weight * r["score"] + (1 - existing_weight) * r["potential"], 3)
        r["tier"] = priority_tier(r["priority"])
        r["existing_tier"] = priority_tier(r["score"]) if r["score"] else None
        r["potential_tier"] = priority_tier(r["potential"]) if r["potential"] else None
    ranked = [r for r in plan["sites"] if r["kind"] == "outreach"] + (list(levers) or own_pages)
    ranked.sort(key=lambda r: (-r["priority"], -r["prompt_count"]))
    for num, r in enumerate(ranked, start=1):
        r["num"] = num
    plan.update(ranked=ranked, targets=[r for r in ranked if r["kind"] == "outreach"], content=own_pages,
                tier_counts=dict(Counter(r["tier"] for r in ranked)))
    return plan


# ── Comparable firms and AI estimates (action_estimates.py) ───────────────────

ESTIMATE_LABELS = {
    "top_3": "Likely top 3",
    "named": "Likely named, outside the top 3",
    "unlikely": "Unlikely to be named",
}


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.casefold())


def mention_order(text: str, names) -> list[str]:
    """Firms in the order an answer first names them, read from the full answer text."""
    return list(_mention_order(text or "", names if isinstance(names, tuple) else tuple(sorted(names))))


@functools.lru_cache(maxsize=4096)
def _mention_order(text: str, names: tuple) -> tuple:
    # Cached: the plan asks for the same answer's order once per action and per estimate,
    # and each call scans the answer for every firm name the crawl's answers mention.
    hits = []
    for n in names:
        m = re.search(rf"(?<![\w-]){re.escape(n)}(?![\w-])", text)
        if m:
            hits.append((m.start(), -len(n), n))
    order, covered_to = [], -1
    for start, neg_len, n in sorted(hits):
        if start < covered_to:
            continue
        order.append(n)
        covered_to = start - neg_len
    return tuple(order)


def brand_for_domain(domain: str, names) -> str | None:
    stem = _norm(domain.split(".")[0])
    best = None
    for n in names:
        key = _norm(n)
        if len(key) >= 4 and (key == stem or stem.startswith(key) or key.startswith(stem)):
            if best is None or abs(len(key) - len(stem)) < abs(len(_norm(best)) - len(stem)):
                best = n
    return best


def _rank_text(ranks: list[int]) -> str:
    if not ranks:
        return "not named"
    lo, hi = min(ranks), max(ranks)
    return f"#{lo}" if lo == hi else f"#{lo} to #{hi}"


def _source_position(citations: list[dict], site: str) -> int | None:
    return next((i for i, c in enumerate(citations, 1)
                 if c["domain"] == site or c["domain"].endswith("." + site)), None)


def comparable(rec: dict, row: dict, platforms: list[str], named_brands) -> dict:
    orders = {p: mention_order(row["platforms"][p]["full_response"], named_brands) for p in platforms}
    profile = row["outreach"].get("profile") or {}

    if rec["rtype"] == "placed_list":
        share = profile.get("list_share")
        text = f"Best-of lists are {share:.0%} of these sources" if share is not None else "No sources cited"
        n = profile.get("third_party_lists") or 0
        detail = (f"{n} citation{'s' if n != 1 else ''} of best-of lists on third-party sites" if n
                  else "No best-of lists on third-party sites cited here")
        return {"text": text, "detail": detail}

    if rec["rtype"] == "own_content":
        if not rec["domains"]:
            share = profile.get("own_share")
            return {"text": f"Firm pages are {share:.0%} of these sources" if share is not None
                    else "No comparable page among the cited sites", "detail": ""}
        positions = []
        for p in platforms:
            pos = [x for x in (_source_position(row["platforms"][p]["citations"], d) for d in rec["domains"]) if x]
            if pos:
                positions.append(f"#{min(pos)} on {PLATFORM_LABELS.get(p, p)}")
        where = f"source {' and '.join(positions)}" if positions else ""
        firms = list(dict.fromkeys(f for f in (brand_for_domain(d, named_brands) for d in rec["domains"]) if f))
        if not firms:
            return {"text": f"Competitor page is {where}" if where else "No comparable data", "detail": ""}
        parts, best = [], []
        for p in platforms:
            ranks = sorted((orders[p].index(f) + 1, f) for f in firms if f in orders[p])
            parts.append(f"{PLATFORM_LABELS.get(p, p)} {_rank_text([r for r, _ in ranks])}")
            if ranks:
                best.append(ranks[0][1])
        who = ", ".join(dict.fromkeys(best)) or ", ".join(firms)
        return {"text": " · ".join(parts), "detail": f"{who}; page is {where}" if where else who}

    checks = [c for d in rec["domains"] for c in row["outreach"]["pages"].get(d, [])]
    read = [c for c in checks if c.get("status") == "checked"]
    if not read:
        if any(c.get("status") == "indexed" for c in checks):
            return {"text": "Other firms on the page unknown", "detail": "Checked through Google's copy of the page"}
        return {"text": "Cited page couldn't be checked", "detail": ""}
    firms = list(dict.fromkeys(f for c in read for f in c.get("competitors_on_page") or []))
    if not firms:
        return {"text": "No firms from these answers on the cited page", "detail": ""}
    parts, named = [], []
    for p in platforms:
        ranks = sorted((orders[p].index(f) + 1, f) for f in firms if f in orders[p])
        parts.append(f"{PLATFORM_LABELS.get(p, p)} {_rank_text([r for r, _ in ranks])}")
        named += [f for _, f in ranks]
    named = list(dict.fromkeys(named))
    detail = ", ".join(named[:3]) + (f" and {len(named) - 3} more" if len(named) > 3 else "")
    return {"text": " · ".join(parts), "detail": f"Firms on the page: {detail}" if named else ""}


def listing_note(brand: str, domain: str, checks: list[dict]) -> str:
    listed = [c for c in checks if c.get("listed")]
    if listed:
        pos = min((c["position"] for c in listed if c.get("position")), default=None)
        where = f", after {pos - 1} of the firms named in this run's answers" if pos and pos > 1 else ""
        return f"{brand} is already listed on the {domain} page cited here{where}"
    if checks and all(c.get("status") in ("checked", "indexed") for c in checks):
        return f"{brand} is not on the {domain} page cited here"
    return f"{brand}'s listing on the {domain} page cited here couldn't be checked"


_ESTIMATE_PROMPT = """{brand} ({domain}) wants to know what each recommended action could do for its place in AI
answers to this buyer prompt: "{prompt}"

Today's answers:
{answers}

Recommended actions:
{actions}

For each action, estimate where {brand} would most likely land in these answers if it completed that action alone and
the AI tools kept citing the same sources. Choose one:
- "top_3": named among the first three firms
- "named": named, but outside the first three
- "unlikely": probably still not named
Weigh how heavily these answers rely on the site's pages, whether the firms on those pages are the ones being named,
and how directly the action puts {brand} on a cited page. Where an action's listing check says {brand} is already
on a cited page, judge what the action adds beyond that listing. Be conservative: when unsure, choose the lower
outcome.

Rules for each reason: under 20 words, neutral third-person voice, plain American English, no em dashes, no Oxford
comma before "and" or "or" in a list.

Reply with JSON only:
{{"estimates": [{{"action": 1, "estimate": "top_3" or "named" or "unlikely", "reason": "..."}}]}}"""


def _estimate_one(brand, domain, item, model) -> tuple[dict | None, float]:
    prompt = _ESTIMATE_PROMPT.format(brand=brand, domain=domain, prompt=item["prompt"], answers=item["answers"],
                                     actions=item["actions"])
    cost = 0.0
    for _ in range(3):
        try:
            resp = _client().messages.create(model=model, max_tokens=1500, messages=[{"role": "user", "content": prompt}])
        except (anthropic.APIStatusError, anthropic.APIConnectionError):
            continue
        cost += _usage_cost(resp)
        parsed = _parse_json("".join(b.text for b in resp.content if b.type == "text"))
        if parsed and isinstance(parsed.get("estimates"), list):
            out = {}
            for e in parsed["estimates"]:
                if isinstance(e, dict) and e.get("estimate") in ESTIMATE_LABELS and isinstance(e.get("action"), int):
                    out[e["action"]] = {"estimate": e["estimate"], "label": ESTIMATE_LABELS[e["estimate"]],
                                        "reason": (e.get("reason") or "").strip()}
            if len(out) == item["count"]:
                return out, cost
    return None, cost


def estimate_actions(brand, domain, items: list[dict], cache: dict, model=RESEARCH_MODEL, workers=8):
    """({prompt: {action_number: estimate}}, new cache entries, cost). cache: {prompt: {"sig", "estimates"}}
    from an earlier build; entries whose inputs are unchanged are reused."""
    def sig(item):
        return hashlib.sha1(f"{brand}\n{item['answers']}\n{item['actions']}".encode("utf-8")).hexdigest()

    out_cache = {it["prompt"]: cache[it["prompt"]] for it in items
                 if cache.get(it["prompt"], {}).get("sig") == sig(it)}
    todo = [it for it in items if it["prompt"] not in out_cache]
    cost = 0.0
    if todo:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for it, (result, c) in zip(todo, pool.map(lambda it: _estimate_one(brand, domain, it, model), todo)):
                cost += c
                if result:
                    out_cache[it["prompt"]] = {"sig": sig(it), "model": model,
                                               "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                               "estimates": {str(k): v for k, v in result.items()}}
    estimates = {p: {int(k): v for k, v in e["estimates"].items()} for p, e in out_cache.items()}
    return estimates, out_cache, cost


# ── Potential (potential.py) ──────────────────────────────────────────────────

OWN_CONTENT_RATE = (0.25, 0.50)
PLACED_LIST_RATE: tuple[float, float] | None = None
EXISTING_WEIGHT = 0.5
FIT_RANGE = (0.5, 1.5)
LIST_PAGE_RE = re.compile(r"(?i)(\bbest\b|\btop\b|\b\d+\s*(?:best|top)\b|\brank(?:ed|ings?)\b|\bround-?up\b|"
                          r"\bcompared\b|\bvs\.?\b)")


def _on(domain: str, site: str) -> bool:
    return domain == site or domain.endswith("." + site)


def _answered(row: dict, platforms: list[str]) -> list[str]:
    return [p for p, _ in _answered_cells(row, platforms)]


def firm_for_domain(domain: str, names) -> str | None:
    base = ".".join(domain.split(".")[-2:])
    return brand_for_domain(base, names) if len(base.split(".")[0]) >= 4 else None


def prompt_profiles(rows: list[dict], platforms: list[str], firm_domains: set[str]) -> dict:
    out = {}
    for row in rows:
        answered = _answered(row, platforms)
        cites = [c for p in answered for c in row["platforms"][p]["citations"]]
        is_firm = [any(_on(c["domain"], d) for d in firm_domains) for c in cites]
        is_list = [bool(LIST_PAGE_RE.search(f"{c['url']} {c.get('title') or ''}")) for c in cites]
        top3 = sum(1 for p in answered
                   if row["platforms"][p]["mentioned"] and (row["platforms"][p]["rank"] or 99) <= 3)
        out[row["prompt"]] = {"list_share": sum(is_list) / len(cites) if cites else None,
                              "own_share": sum(is_firm) / len(cites) if cites else None,
                              "third_party_lists": sum(1 for f, l in zip(is_firm, is_list) if l and not f),
                              "open": 1 - top3 / len(answered) if answered else 1.0}
    return out


def _mean(values) -> float | None:
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def lever_potential(rate, share, mean, open_share) -> dict:
    tilt = min(max(share / mean, FIT_RANGE[0]), FIT_RANGE[1]) if share is not None and mean else 1.0
    low, high = (min(1.0, r * tilt) * open_share for r in rate)
    return {"low": low, "high": high, "mid": (low + high) / 2, "tilt": tilt, "share": share, "mean": mean,
            "open": open_share}


def potential_text(lever: str, pot: dict, rate: dict) -> dict:
    if not pot["open"]:
        return {"text": "Already in the top 3 here", "detail": ""}
    text = f"{pot['low']:.0%} to {pot['high']:.0%} chance of the top 3"
    if pot["low"] == pot["high"]:
        text = f"{pot['low']:.0%} chance of the top 3"
    source = {"track record": "track record", "tool": "tool estimate", "set": "set rate"}[rate["source"]]
    base = f"{source} of {rate['low']:.0%} to {rate['high']:.0%}"
    kind = "Firm pages" if lever == "own" else "Best-of lists"
    if pot["share"] is None or not pot["mean"]:
        return {"text": text, "detail": f"From a {base}"}
    way = "raised" if pot["tilt"] > 1.005 else "lowered" if pot["tilt"] < 0.995 else "kept"
    return {"text": text, "detail": f"From a {base}, {way} for fit: {kind.lower()} are {pot['share']:.0%} of these "
                                    f"sources, {pot['mean']:.0%} across all prompts"}


def self_list_stat(rows, platforms, owned_domains, names) -> tuple[int, int]:
    total = top3 = 0
    for row in rows:
        for p in _answered(row, platforms):
            cell = row["platforms"][p]
            first3 = mention_order(cell["full_response"], names)[:3]
            for d in dict.fromkeys(c["domain"] for c in cell["citations"] if any(_on(c["domain"], o) for o in owned_domains)):
                firm = firm_for_domain(d, names)
                if firm:
                    total += 1
                    top3 += firm in first3
    return top3, total


_PLACED_RATE_PROMPT = """{brand} ({domain}) can place "Top 10" or "Best of" articles that rank {brand} first on
high-authority publications such as major business and news sites. For each buyer prompt below, assume one article
written for that prompt's question and placed on such a publication. Estimate for what share of the prompts that
article would move {brand} from where it is now into the top 3 firms named in AI answers to the prompt, within a few
months of publishing, with the article as the one change.

Evidence from {brand}'s AI-visibility run ({prompt_count} prompts on {platforms}):
- {brand} today: {status}
- Share of the sources these answers cite that are best-of, top-N or ranking articles: {list_shares}.
- Answers to {third_party} of the {prompt_count} prompts cite at least one best-of list on a third-party site rather
  than a firm's own site.
- Answers that cite a best-of list a firm publishes on its own site: {self_total}. That firm is among the first
  three firms named in {self_top3} of them. Some of those mentions are warnings that the list ranks its own
  publisher first, which AI answers to these prompts often give.
- For comparison, the agency's track record for a page on the client's own site answering a prompt: {own_low} to
  {own_high} of prompts move from unranked to the top 3.

The prompts:
{prompts}

Be conservative. Reply with JSON only:
{{"low": whole percent, "high": whole percent, "reason": "one sentence under 30 words, neutral third-person voice,
plain American English, no em dashes, no Oxford comma"}}"""


def placed_list_rate(brand, domain, evidence: dict, cache: dict | None, model=RESEARCH_MODEL):
    """(rate or None, cache entry or None, cost). Reuses the earlier build's rate when its inputs match."""
    if PLACED_LIST_RATE:
        return {"low": PLACED_LIST_RATE[0], "high": PLACED_LIST_RATE[1], "source": "set", "reason": ""}, None, 0.0
    prompt = _PLACED_RATE_PROMPT.format(brand=brand, domain=domain, **evidence)
    sig = hashlib.sha1(prompt.encode("utf-8")).hexdigest()
    if cache and cache.get("sig") == sig:
        return cache["rate"], cache, 0.0
    cost = 0.0
    for _ in range(3):
        try:
            resp = _client().messages.create(model=model, max_tokens=600, messages=[{"role": "user", "content": prompt}])
        except (anthropic.APIStatusError, anthropic.APIConnectionError):
            continue
        cost += _usage_cost(resp)
        parsed = _parse_json("".join(b.text for b in resp.content if b.type == "text")) or {}
        low, high = parsed.get("low"), parsed.get("high")
        if isinstance(low, (int, float)) and isinstance(high, (int, float)) and 0 <= low <= high <= 100:
            rate = {"low": low / 100, "high": high / 100, "source": "tool", "reason": (parsed.get("reason") or "").strip()}
            return rate, {"sig": sig, "model": model, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                          "rate": rate}, cost
    return None, None, cost


def build_levers(brand, domain, client_host, rows, platforms, plan, names, placed_cache):
    total = len(rows)
    owned = {s["domain"] for s in plan["sites"] if s["research"].get("competitor_owned") or s["kind"] == "own_page"}
    cited_domains = {c["domain"] for row in rows for _, cell in _answered_cells(row, platforms) for c in cell["citations"]}
    firm_domains = owned | {d for d in cited_domains if firm_for_domain(d, names)} | {client_host}
    profiles = prompt_profiles(rows, platforms, firm_domains)
    means = {k: _mean(pr[k] for pr in profiles.values()) for k in ("list_share", "own_share")}
    list_prompts = {q for q, pr in profiles.items() if pr["third_party_lists"]}

    own_rate = {"low": OWN_CONTENT_RATE[0], "high": OWN_CONTENT_RATE[1], "source": "track record", "reason": ""}
    top3, self_total = self_list_stat(rows, platforms, owned, names)
    answered = [(row, p) for row in rows for p in _answered(row, platforms)]
    named = sum(1 for row, p in answered if row["platforms"][p]["mentioned"])
    in_top3 = sum(1 for row, p in answered if row["platforms"][p]["mentioned"] and (row["platforms"][p]["rank"] or 99) <= 3)
    list_shares = []
    for p in platforms:
        cites = [c for row in rows if p in _answered(row, platforms) for c in row["platforms"][p]["citations"]]
        if cites:
            n = sum(1 for c in cites if LIST_PAGE_RE.search(f"{c['url']} {c.get('title') or ''}"))
            list_shares.append(f"{n / len(cites):.0%} on {PLATFORM_LABELS.get(p, p)}")
    evidence = {
        "prompt_count": total,
        "platforms": ", ".join(PLATFORM_LABELS.get(p, p) for p in platforms),
        "status": f"named in {named} of {len(answered)} answers, in the top 3 of {in_top3}",
        "list_shares": ", ".join(list_shares) or "no sources cited",
        "third_party": len(list_prompts),
        "self_total": self_total,
        "self_top3": top3,
        "own_low": f"{OWN_CONTENT_RATE[0]:.0%}",
        "own_high": f"{OWN_CONTENT_RATE[1]:.0%}",
        "prompts": "\n".join(f'- "{row["prompt"]}"' for row in rows),
    }
    list_rate, placed_entry, cost = placed_list_rate(brand, domain, evidence, placed_cache)

    per_prompt = {}
    for row in rows:
        pr = profiles[row["prompt"]]
        per_prompt[row["prompt"]] = {
            "profile": pr,
            "own": lever_potential((own_rate["low"], own_rate["high"]), pr["own_share"], means["own_share"], pr["open"]),
            "list": (lever_potential((list_rate["low"], list_rate["high"]), pr["list_share"], means["list_share"],
                                     pr["open"]) if list_rate else None),
        }
    own_pages = [s for s in plan["sites"] if s["kind"] == "own_page"]
    own_covered = set().union(*(set(s["prompts"]) for s in own_pages)) if own_pages else set()
    levers = [{
        "kind": "lever", "lever": "own", "rtype": "own_content", "domain": client_host,
        "label": route_label("own_content", "free"), "subtitle": "Your own pages",
        "prompt_count": len(own_covered), "citations": None,
        "score": round(len(own_covered) / total * ROUTE_WEIGHT["own_content"], 3) if total else 0.0,
        "potential": round(_mean(v["own"]["mid"] for v in per_prompt.values()) or 0.0, 3),
        "rate": own_rate,
    }]
    if list_rate:
        levers.append({
            "kind": "lever", "lever": "list", "rtype": "placed_list", "domain": "High-authority publication",
            "label": route_label("placed_list", "paid"), "subtitle": "Placed Top 10 article",
            "prompt_count": len(list_prompts), "citations": None,
            "score": round(len(list_prompts) / total * ROUTE_WEIGHT["placed_list"], 3) if total else 0.0,
            "potential": round(_mean(v["list"]["mid"] for v in per_prompt.values()) or 0.0, 3),
            "rate": list_rate,
        })
    return levers, per_prompt, {"own": own_rate, "list": list_rate}, placed_entry, cost


# ── The whole plan (geo_citation_checker.py's wiring) ─────────────────────────

def build_plan(brand: str, client_domain: str, rows: list[dict], platforms: list[str], target_domains: list[str],
               named_brands: set[str], site_cache: dict, placed_cache: dict | None, estimate_cache: dict) -> dict:
    """site_cache: {site: {"research", "pages": {clean url: check}, "researched_at"}}. Returns the plan
    as the Outreach Plan tab renders it, the caches the next build can reuse, and the cost."""
    client_host = domain_of(client_domain)
    prompts = [row["prompt"] for row in rows]
    total_prompts = len(set(prompts))
    stats = site_stats(rows, platforms, target_domains, client_host)
    plan = _plan_sites(stats, target_domains, site_cache, named_brands, prompts, total_prompts)
    rank_plan(plan)

    plan_sites = {s["domain"]: s for s in plan["sites"]}
    researched = [s["domain"] for s in plan["sites"] if not s["research"].get("competitor_owned")]
    rank_names = tuple(sorted(n for n in named_brands if not any(_is_site_itself(n, d) for d in researched)))

    levers, per_prompt, rates, placed_entry, cost = build_levers(
        brand, client_domain, client_host, rows, platforms, plan, rank_names, placed_cache)
    rank_plan(plan, levers, EXISTING_WEIGHT)
    own_lever = levers[0]
    list_lever = next((lv for lv in levers if lv["lever"] == "list"), None)

    for row in rows:
        cited, pages = [], {}
        for p in platforms:
            cell = row["platforms"].get(p)
            if not cell:
                continue
            for c in cell["citations"]:
                d = next((s for s in plan_sites if c["domain"] == s or c["domain"].endswith("." + s)), None)
                if d and d not in cited:
                    cited.append(d)
                check = plan_sites[d]["checks"].get(clean_url(c["url"])) if d else None
                if check and check not in pages.setdefault(d, []):
                    pages[d].append(check)
        listed_here = {d for d, checks in pages.items() if any(ch.get("listed") for ch in checks)}
        pp = per_prompt[row["prompt"]]
        targets = [plan_sites[d] for d in cited if plan_sites[d]["kind"] == "outreach"
                   and not plan_sites[d]["research"].get("competitor_owned")]
        own_domains = [d for d in cited if plan_sites[d]["kind"] == "own_page"]
        recs = group_prompt_actions(targets, listed_here)
        recs.append({
            "fee": "Free", "rtype": "own_content", "lever": "own", "domains": own_domains,
            "text": "Build your own page answering this question"
                    + (f" to compete with {_join_names(own_domains)}" if own_domains else ""),
            "nums": [own_lever["num"]], "tier": own_lever["tier"],
            "existing": own_lever["score"] if own_domains else 0.0, "potential": pp["own"]["mid"],
            "potential_text": potential_text("own", pp["own"], rates["own"])})
        placed = list_lever and pp["list"]["open"]
        if placed:
            recs.append({
                "fee": "Paid", "rtype": "placed_list", "lever": "list", "domains": [],
                "text": "Place a Top 10 article on a high-authority publication",
                "nums": [list_lever["num"]], "tier": list_lever["tier"],
                "existing": list_lever["score"] if pp["profile"]["third_party_lists"] else 0.0,
                "potential": pp["list"]["mid"],
                "potential_text": potential_text("list", pp["list"], rates["list"])})
        for rec in recs:
            rec["priority"] = EXISTING_WEIGHT * rec["existing"] + (1 - EXISTING_WEIGHT) * rec["potential"]
        recs.sort(key=lambda r: -r["priority"])
        row["outreach"] = {"recommendations": recs, "pages": pages, "profile": pp["profile"],
                           "listed_here": sorted(listed_here)}

    # Comparable firms and the AI estimate per action. The two new-page actions show their
    # chance once AI cites the page instead, so they aren't sent for the estimate.
    def estimated(recs):
        return [rec for rec in recs if "lever" not in rec]

    estimate_items = []
    for row in rows:
        answered = _answered(row, platforms)
        recs = row["outreach"]["recommendations"]
        for rec in recs:
            rec["comparable"] = comparable(rec, row, answered, rank_names)
        answers, sources = [], {}
        for p in answered:
            cell = row["platforms"][p]
            status = (f"{brand} is named (rank {cell['rank']})" if cell["mentioned"] and cell["rank"]
                      else f"{brand} is named" if cell["mentioned"] else f"{brand} is not named")
            firms = mention_order(cell["full_response"], rank_names)[:15]
            sources[p] = list(dict.fromkeys(c["domain"] for c in cell["citations"] if c["domain"]))
            answers.append(f"- {PLATFORM_LABELS.get(p, p)}: {status}. Firms named, in order: "
                           f"{', '.join(firms) or 'none'}. All {len(sources[p])} sources cited, in order: "
                           f"{', '.join(sources[p]) or 'none'}.")
        lines = []
        for i, rec in enumerate(estimated(recs), 1):
            comp = rec["comparable"]
            notes = " ".join(plan_sites[d]["research"].get("why", "") for d in rec["domains"])[:400]
            cited_as = "; ".join(
                f"{d} is " + ", ".join(
                    (f"source #{next(k for k, s in enumerate(sources[p], 1) if s == d or s.endswith('.' + d))}"
                     if any(s == d or s.endswith("." + d) for s in sources[p]) else "not cited")
                    + f" on {PLATFORM_LABELS.get(p, p)}" for p in answered)
                for d in rec["domains"])
            listing = "; ".join(listing_note(brand, d, row["outreach"]["pages"].get(d, [])) for d in rec["domains"])
            lines.append(f"{i}. {rec['fee']}: {rec['text']}. Comparable firms today: {comp['text']}"
                         + (f" ({comp['detail']})" if comp["detail"] else "") + "."
                         + (f" In these answers, {cited_as}." if cited_as else "")
                         + (f" Listing check: {listing}." if listing else "")
                         + (f" Site notes: {notes}" if notes else ""))
        if lines:
            estimate_items.append({"prompt": row["prompt"], "answers": "\n".join(answers),
                                   "actions": "\n".join(lines), "count": len(lines)})
    # A cheap local test build estimates only the first few prompts; never set in production.
    test_limit = int(os.environ.get("OUTREACH_TEST_ESTIMATE_LIMIT") or 0)
    if test_limit:
        estimate_items = estimate_items[:test_limit]
    estimates, estimate_entries, est_cost = estimate_actions(brand, client_domain, estimate_items, estimate_cache or {})
    cost += est_cost
    for row in rows:
        for i, rec in enumerate(estimated(row["outreach"]["recommendations"]), 1):
            rec["estimate"] = estimates.get(row["prompt"], {}).get(i)

    # What the tab renders. Site rows drop their by-URL check map (pages carries the same
    # checks); the priority list refers to sites and levers rather than repeating them.
    def site_out(s):
        return {k: v for k, v in s.items() if k != "checks"}

    ranked = [{"num": r["num"], "ref": f"lever:{r['lever']}" if r["kind"] == "lever" else f"site:{r['domain']}"}
              for r in plan["ranked"]]
    return {
        "plan": {
            "sites": [site_out(s) for s in plan["sites"]],
            "levers": levers,
            "ranked": ranked,
            "groups": plan["groups"],
            "total_prompts": total_prompts,
            "tier_counts": plan["tier_counts"],
            "model": RESEARCH_MODEL,
            "rates": rates,
            "existing_weight": EXISTING_WEIGHT,
            "prompts": [{"prompt": row["prompt"], "category": row.get("category"),
                         "recommendations": row["outreach"]["recommendations"],
                         "listed_here": row["outreach"]["listed_here"]} for row in rows],
        },
        "caches": {"placed": placed_entry, "estimates": estimate_entries},
        "cost": round(cost, 4),
    }
