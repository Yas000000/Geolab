"""
AI crawler access checks: can Claude, Gemini and ChatGPT's own live infrastructure
reach a client's site? Ported from ai-crawlability-checker/checkers.py with the
same per-vendor mechanism and confidence tiers; the three checks are async here so
they run in parallel inside one serverless call.

Each vendor's hosted API is asked to reach the URL itself, rather than spoofing a
crawler User-Agent from our own IP (which can only prove "this server rejects an
unverified request claiming to be GPTBot", never "the real crawler is blocked").

Confidence tiers, deliberately not collapsed into one verdict:
  - Claude web_fetch: forces a live fetch of the exact URL. "live-fetch", high.
  - Gemini url_context: fetches the exact URL but checks Google's own cache first,
    so a success is slightly weaker evidence of access right now. High.
  - ChatGPT: the API has no fetch-a-URL tool, only web_search. A hit proves the site
    is in its search index, not that it can reach the site. Medium, and it only
    counts when a cited URL is on the target domain itself -- a scraped copy of the
    site's text on a directory site (seen live: wiza.co for shippei.com) doesn't count.
"""

import os
from dataclasses import asdict, dataclass
from urllib.parse import urlparse


@dataclass
class CheckResult:
    vendor: str                    # "claude" | "gemini" | "chatgpt"
    tier: str                      # "live-fetch" | "fetch (cache-or-live)" | "search-index-presence"
    confidence: str                # "high" | "medium"
    success: bool                  # did the vendor's tool reach the site / find it on the site's own domain
    detail: str


def _domain(url: str) -> str:
    netloc = urlparse(url).netloc.lower()
    return netloc[4:] if netloc.startswith("www.") else netloc


async def check_claude(url: str) -> CheckResult:
    import anthropic

    prompt = (
        f"Fetch {url} and report the exact page title you see. "
        f"If the fetch itself fails, start your reply with FETCH_FAILED and report the exact error."
    )
    client = anthropic.AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    try:
        resp = await client.messages.create(
            model="claude-opus-5",
            max_tokens=1024,
            tools=[{"type": "web_fetch_20260209", "name": "web_fetch"}],
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as e:
        return CheckResult("claude", "live-fetch", "high", False, f"API error: {e}")

    data = resp.model_dump()
    fetch_ok, fetch_error = False, None
    for block in data.get("content", []):
        if block.get("type") == "web_fetch_tool_result":
            inner = block.get("content") or {}
            if inner.get("type") == "web_fetch_result":
                fetch_ok = True
            else:
                fetch_error = inner

    # Claude often writes a preamble ("I'll fetch that URL...") before the tool call
    # and its real answer after the result -- the LAST text block is the answer.
    text_blocks = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    final_text = (text_blocks[-1] if text_blocks else "").strip()

    if not fetch_ok:
        detail = str(fetch_error) if fetch_error else (final_text or "web_fetch never returned a result")
        return CheckResult("claude", "live-fetch", "high", False, detail[:500])
    return CheckResult("claude", "live-fetch", "high", True, final_text[:300])


async def check_gemini(url: str) -> CheckResult:
    from google import genai
    from google.genai import types

    # v1beta pinned: google-genai 3.x defaults to v1, which 404s this model
    # (see _gemini_client in platforms.py).
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"],
                          http_options=types.HttpOptions(api_version="v1beta"))
    try:
        resp = await client.aio.models.generate_content(
            model="gemini-flash-lite-latest",
            contents=f"Using the URL context tool, fetch {url} and report the exact page title.",
            config=types.GenerateContentConfig(tools=[types.Tool(url_context=types.UrlContext())]),
        )
    except Exception as e:
        return CheckResult("gemini", "fetch (cache-or-live)", "high", False, f"API error: {str(e)[:400]}")

    cand = resp.candidates[0] if resp.candidates else None
    url_meta = getattr(cand, "url_context_metadata", None)
    entries = url_meta.url_metadata if url_meta and url_meta.url_metadata else []
    status = entries[0].url_retrieval_status if entries else None
    if status is None or "SUCCESS" not in str(status):
        return CheckResult("gemini", "fetch (cache-or-live)", "high", False, f"Retrieval status: {status}")
    return CheckResult("gemini", "fetch (cache-or-live)", "high", True, (resp.text or "").strip()[:300])


async def check_chatgpt(url: str, brand: str | None) -> CheckResult:
    from openai import AsyncOpenAI

    target = _domain(url)
    # Brand alone is unreliable ("PEI" matched Prince Edward Island's sites, never
    # shippei.com) -- brand + domain anchors the search on the right site.
    query = f"{brand} {target}" if brand else target
    client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
    try:
        resp = await client.responses.create(
            model="gpt-4o",
            tools=[{"type": "web_search"}],
            input=f'Search for "{query}" and tell me every URL it appears on, especially the official website.',
        )
    except Exception as e:
        return CheckResult("chatgpt", "search-index-presence", "medium", False, f"API error: {e}")

    cited = []
    for item in resp.output:
        if item.type == "message":
            for c in item.content:
                for a in getattr(c, "annotations", None) or []:
                    if getattr(a, "type", "") == "url_citation":
                        cited.append(_domain(a.url))
    on_target = any(d == target or d.endswith("." + target) for d in cited)
    detail = f"Cited sites: {', '.join(sorted(set(cited))) or 'none'}"
    return CheckResult("chatgpt", "search-index-presence", "medium", on_target, detail)


async def resolve_site_url(url: str) -> str:
    """Follows the site's own redirects (example.com -> https://www.example.com/)
    with one plain request from our server and returns where it lands. Claude's
    web_fetch won't follow a redirect to a different host -- it returned
    url_not_allowed for seattlechildrens.org, which redirects to www (2026-11-06),
    and that would read as "blocked". If our own request fails (a site that
    blocks non-browser traffic), the URL is used as given.

    If the host can't be connected to at all, the www/bare twin is tried
    next: seattlechildrens.org's bare host serves an incomplete certificate
    chain (Python and Claude's fetcher both reject it), while www works."""
    import httpx

    parts = urlparse(url)
    host = parts.netloc
    twin = host[4:] if host.startswith("www.") else f"www.{host}"
    for candidate in (url, parts._replace(netloc=twin).geturl()):
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=10.0,
                                         headers={"User-Agent": "Mozilla/5.0"}) as http:
                r = await http.get(candidate)
            return str(r.url)
        except httpx.ConnectError:
            continue  # unreachable or certificate rejected -- try the twin host
        except Exception:
            break
    return url


async def run_all_checks(url: str, brand: str | None = None) -> tuple[str, list[dict]]:
    """Returns (the URL actually checked, per-vendor results)."""
    import asyncio

    url = await resolve_site_url(url)
    results = await asyncio.gather(check_claude(url), check_gemini(url), check_chatgpt(url, brand))
    return url, [asdict(r) for r in results]
