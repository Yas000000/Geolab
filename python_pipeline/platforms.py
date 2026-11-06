"""
AI platform clients. Each returns a plain string response for a given prompt.

Ported from geo-rank-checker/platforms.py with one deliberate, flagged
deviation from "port verbatim": the 3 query functions are converted from
synchronous to `async def`, using each provider's async SDK client, so the
orchestration layer can run many of these concurrently instead of the
source's fully-sequential loop (25 prompts x 3 platforms = 75 blocking calls
in the CLI today -- would badly exceed a serverless function's time limit).
Model IDs, the shared system prompt, and each function's exact retry policy
are preserved unchanged -- this is a concurrency-only change, not an
algorithm change.
"""

import asyncio
import os
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


@dataclass
class PlatformResult:
    platform: str
    response: str
    error: str | None = None
    # Live Search only: the pages the answer cited, in first-cited order,
    # de-duplicated by URL -- [{"url", "title", "domain"}]. Always empty for
    # Training Search (no web access, nothing to cite).
    citations: list = field(default_factory=list)


def _domain_of(url: str) -> str:
    host = urlsplit(url).hostname or ""
    return host[4:] if host.startswith("www.") else host


def _clean_url(url: str) -> str:
    # ChatGPT appends ?utm_source=openai to every cited link; without
    # stripping it the same page cited by ChatGPT and Claude would count as
    # two different pages.
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not (k == "utm_source" and v == "openai")]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _dedupe_citations(pairs: list[tuple[str, str]], domain_hints: dict[str, str] | None = None) -> list[dict]:
    out, seen = [], set()
    for url, title in pairs:
        if not url:
            continue
        url = _clean_url(url)
        if url in seen:
            continue
        seen.add(url)
        domain = _domain_of(url)
        if domain_hints and url in domain_hints:
            domain = domain_hints[url]
        out.append({"url": url, "title": (title or "").strip() or None, "domain": domain})
    return out


_SYSTEM_PROMPT = (
    "You are a helpful assistant. When listing brands, companies, products, services, or providers, "
    "always use a numbered list (1., 2., 3., etc.). Keep each list item concise — brand or company "
    "name first, then a brief description if needed."
)

# Ported from geo-rank-checker/platforms.py's proven live-search instruction --
# attaching a web_search tool only makes search AVAILABLE, the model still
# decides whether to use it. Without this stronger instruction, a confident-
# sounding "best X firms" question gets answered from static training memory
# without ever searching, which defeats the entire point of Live Search mode
# (this was a real bug found live on that sibling tool, not a hypothetical).
_LIVE_SEARCH_SYSTEM_PROMPT = _SYSTEM_PROMPT + (
    " You have a web_search tool. You must use it at least once before answering this question, even if "
    "you believe you already know the answer -- the user needs current, real search results, not your own "
    "training-data recall. Your numbered list must name actual companies, firms, or providers found in your "
    "search results -- never generic advice, tips, strategies, or explanations as list items. If your search "
    "genuinely turns up no relevant named providers, say so in plain text instead of listing non-company items."
)


async def query_openai(prompt: str) -> PlatformResult:
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
        resp = await client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            max_tokens=1024,
        )
        return PlatformResult("ChatGPT (GPT-4o)", resp.choices[0].message.content or "")
    except Exception as e:
        return PlatformResult("ChatGPT (GPT-4o)", "", error=str(e))


async def query_claude(prompt: str) -> PlatformResult:
    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        resp = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        return PlatformResult("Claude (Sonnet 4.6)", resp.content[0].text)
    except Exception as e:
        return PlatformResult("Claude (Sonnet 4.6)", "", error=str(e))


async def query_gemini(prompt: str) -> PlatformResult:
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    last_err = ""
    for attempt in range(3):
        try:
            resp = await client.aio.models.generate_content(
                model="gemini-flash-lite-latest",
                contents=prompt,
                config=types.GenerateContentConfig(system_instruction=_SYSTEM_PROMPT),
            )
            return PlatformResult("Gemini (Flash Lite)", resp.text)
        except Exception as e:
            last_err = str(e)
            # Retry on transient server overload; bail immediately on quota/auth errors
            if "503" in last_err or "UNAVAILABLE" in last_err:
                await asyncio.sleep(5 * (attempt + 1))
            else:
                break
    return PlatformResult("Gemini (Flash Lite)", "", error=last_err)


# --- Live Search variants -- same models, but with a real web_search tool
# attached instead of answering from static training-data recall. Each tool
# type/shape below was verified against a real live API call (not just docs)
# on 2026-10-12, since this family's own prior experience is that recalled/
# documented tool-type strings drift. The Claude tool type was switched back
# from web_search_20260209 to web_search_20250305 on 2026-11-06 for its
# citations -- see query_claude_live.

async def query_openai_live(prompt: str) -> PlatformResult:
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
        resp = await client.responses.create(
            model="gpt-4o",
            instructions=_LIVE_SEARCH_SYSTEM_PROMPT,
            tools=[{"type": "web_search"}],
            input=prompt,
        )
        # Cited pages are url_citation annotations on the message's text
        # (confirmed live 2026-11-06; same shape geo-citation-checker uses).
        pairs = []
        for item in resp.output:
            if item.type != "message":
                continue
            for block in item.content:
                for ann in getattr(block, "annotations", None) or []:
                    if getattr(ann, "type", None) == "url_citation":
                        pairs.append((ann.url, getattr(ann, "title", "")))
        return PlatformResult("ChatGPT (GPT-4o, live search)", resp.output_text or "",
                              citations=_dedupe_citations(pairs))
    except Exception as e:
        return PlatformResult("ChatGPT (GPT-4o, live search)", "", error=str(e))


async def query_claude_live(prompt: str) -> PlatformResult:
    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        resp = await client.messages.create(
            model="claude-sonnet-4-6",
            # Was 1024, which cut live answers off mid-list: a full live-search
            # answer took ~1,400 output tokens in a live test (2026-11-06,
            # stop_reason "max_tokens" at 1024, "end_turn" at 4096).
            max_tokens=4096,
            system=_LIVE_SEARCH_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
            # web_search_20250305, not the newer web_search_20260209: tested
            # live side by side 2026-11-06 on the same prompt -- 20260209
            # (search results filtered through code execution) returned text
            # blocks with no citations at all, 20250305 returned 15 real
            # per-claim citations. Citations are what the Citations page reports.
            tools=[{"type": "web_search_20250305", "name": "web_search"}],
        )
        text = "".join(block.text for block in resp.content if block.type == "text")
        pairs = []
        for block in resp.content:
            if block.type != "text":
                continue
            for cite in getattr(block, "citations", None) or []:
                if getattr(cite, "type", None) == "web_search_result_location":
                    pairs.append((cite.url, getattr(cite, "title", "")))
        return PlatformResult("Claude (Sonnet 4.6, live search)", text, citations=_dedupe_citations(pairs))
    except Exception as e:
        return PlatformResult("Claude (Sonnet 4.6, live search)", "", error=str(e))


async def query_gemini_live(prompt: str) -> PlatformResult:
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    last_err = ""
    for attempt in range(3):
        try:
            resp = await client.aio.models.generate_content(
                model="gemini-flash-lite-latest",
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=_LIVE_SEARCH_SYSTEM_PROMPT,
                    tools=[types.Tool(google_search=types.GoogleSearch())],
                ),
            )
            citations = await _gemini_citations(resp)
            return PlatformResult("Gemini (Flash Lite, live search)", resp.text, citations=citations)
        except Exception as e:
            last_err = str(e)
            if "503" in last_err or "UNAVAILABLE" in last_err:
                await asyncio.sleep(5 * (attempt + 1))
            else:
                break
    return PlatformResult("Gemini (Flash Lite, live search)", "", error=last_err)


async def _gemini_citations(resp) -> list[dict]:
    """Gemini's grounding chunks are its cited sources, but each chunk's uri
    is a vertexaisearch.cloud.google.com redirect, not the real page, and its
    title is the site's domain. The redirect is resolved by reading its
    Location header (no request is made to the page itself); if that fails,
    the redirect URL is kept and the domain comes from the title, so the
    citation still counts toward the right site.

    NOT live-confirmed: every grounded Gemini call on this account has
    returned 429 RESOURCE_EXHAUSTED (re-checked 2026-11-06). Read defensively
    from Google's documented shape; check the first real Gemini citations.
    """
    candidate = resp.candidates[0] if getattr(resp, "candidates", None) else None
    meta = getattr(candidate, "grounding_metadata", None) if candidate else None
    chunks = getattr(meta, "grounding_chunks", None) or []
    raw = []
    for chunk in chunks:
        web = getattr(chunk, "web", None)
        uri = getattr(web, "uri", None) if web else None
        if uri:
            hint = getattr(web, "domain", None) or getattr(web, "title", None) or ""
            raw.append((uri, getattr(web, "title", "") or "", hint.strip().lower().removeprefix("www.")))
    if not raw:
        return []

    import httpx

    async def resolve(uri: str) -> str:
        if "vertexaisearch.cloud.google.com" not in uri:
            return uri
        try:
            async with httpx.AsyncClient(follow_redirects=False, timeout=5.0) as http:
                r = await http.get(uri)
            return r.headers.get("location") or uri
        except Exception:
            return uri

    resolved = await asyncio.gather(*(resolve(uri) for uri, _, _ in raw))
    pairs, hints = [], {}
    for (uri, title, hint), real in zip(raw, resolved):
        pairs.append((real, title))
        if real == uri and hint:  # unresolved redirect: count it under the site Gemini named
            hints[_clean_url(real)] = hint
    return _dedupe_citations(pairs, hints)


# Registry — add perplexity here when key is available
PLATFORMS = {
    "openai": query_openai,
    "claude": query_claude,
    "gemini": query_gemini,
}

PLATFORMS_LIVE = {
    "openai": query_openai_live,
    "claude": query_claude_live,
    "gemini": query_gemini_live,
}
