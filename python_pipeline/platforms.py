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
import re
import time
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


@dataclass
class PlatformResult:
    platform: str
    response: str
    error: str | None = None
    # Live Search only: the pages the answer cited, in first-cited order,
    # de-duplicated by URL -- [{"url", "title", "domain", "spans"?}]. Always
    # empty for Training Search (no web access, nothing to cite). "spans" is
    # the parts of `response` that page backs (see _attach_spans); absent
    # when the platform gives none (Perplexity) or none could be placed.
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


def _attach_spans(citations: list[dict], text: str, raw_spans: list[tuple[str, int, int]]) -> list[dict]:
    """Adds "spans": [[start, end], ...] to each citation: the stretches of
    the answer that page backs, from the platform's own per-claim citation
    data. raw_spans are (url, start, end) as Python character offsets into
    `text`; they're stored as UTF-16 offsets, which is how JavaScript indexes
    the same string, so the portal can slice responseText with them directly
    (the two differ only after a character outside the BMP, e.g. an emoji).
    What a span covers differs by platform: Claude and Gemini mark the cited
    claim itself, ChatGPT marks the inline "([site](url))" link it places
    inside the sentence, just before the period."""
    by_url = {c["url"]: c for c in citations}
    found: dict[str, set] = {}
    for url, start, end in raw_spans:
        cite = by_url.get(_clean_url(url)) if url else None
        start, end = max(0, start), min(len(text), end)
        if cite is not None and start < end:
            found.setdefault(cite["url"], set()).add((start, end))
    if not found:
        return citations
    simple = all(ord(ch) <= 0xFFFF for ch in text)

    def utf16(i: int) -> int:
        return i if simple else len(text[:i].encode("utf-16-le")) // 2

    for cite in citations:
        spans = sorted(found.get(cite["url"], ()))
        if spans:
            cite["spans"] = [[utf16(s), utf16(e)] for s, e in spans]
    return citations


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


def _gemini_client():
    """google-genai 3.0 (2026-11-06) switched its default API version from
    v1beta to v1, which does not serve gemini-flash-lite-latest: every call
    returned 404 NOT_FOUND on production once a deploy picked up 3.x. Pinned
    to v1beta here so the SDK's default can't change the endpoint again."""
    from google import genai
    from google.genai import types
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"],
                        http_options=types.HttpOptions(api_version="v1beta"))


async def query_gemini(prompt: str) -> PlatformResult:
    from google.genai import types
    client = _gemini_client()
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
        # Each annotation's start/end_index are character offsets into its
        # own output_text block (verified live 2026-11-12: every one sliced
        # exactly to its "([site](url))" link), so blocks are offset by the
        # text before them -- output_text is the blocks joined with "".
        pairs, raw_spans, joined = [], [], ""
        for item in resp.output:
            if item.type != "message":
                continue
            for block in item.content:
                base = len(joined)
                joined += getattr(block, "text", "") if getattr(block, "type", None) == "output_text" else ""
                for ann in getattr(block, "annotations", None) or []:
                    if getattr(ann, "type", None) == "url_citation":
                        pairs.append((ann.url, getattr(ann, "title", "")))
                        if ann.start_index is not None and ann.end_index is not None:
                            raw_spans.append((ann.url, base + ann.start_index, base + ann.end_index))
        text = resp.output_text or ""
        citations = _dedupe_citations(pairs)
        if joined == text:  # never place spans on text they weren't measured against
            _attach_spans(citations, text, raw_spans)
        return PlatformResult("ChatGPT (GPT-4o, live search)", text, citations=citations)
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
        # Claude splits its answer into text blocks and attaches citations to
        # the block holding the cited claim, so each citation's span is its
        # block's place in the joined text.
        parts, pairs, raw_spans, offset = [], [], [], 0
        for block in resp.content:
            if block.type != "text":
                continue
            start = offset
            offset += len(block.text)
            parts.append(block.text)
            for cite in getattr(block, "citations", None) or []:
                if getattr(cite, "type", None) == "web_search_result_location":
                    pairs.append((cite.url, getattr(cite, "title", "")))
                    raw_spans.append((cite.url, start, offset))
        text = "".join(parts)
        citations = _attach_spans(_dedupe_citations(pairs), text, raw_spans)
        return PlatformResult("Claude (Sonnet 4.6, live search)", text, citations=citations)
    except Exception as e:
        return PlatformResult("Claude (Sonnet 4.6, live search)", "", error=str(e))


async def query_gemini_live(prompt: str) -> PlatformResult:
    from google.genai import types
    client = _gemini_client()
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
            return PlatformResult("Gemini (Flash Lite, live search)", resp.text or "", citations=citations)
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

    Live-confirmed 2026-11-11 once the new paid-tier key was in place: a
    grounded answer returned 6 chunks, all resolved to real pages.
    """
    candidate = resp.candidates[0] if getattr(resp, "candidates", None) else None
    meta = getattr(candidate, "grounding_metadata", None) if candidate else None
    chunks = getattr(meta, "grounding_chunks", None) or []
    raw = []
    chunk_raw: list[int | None] = []  # chunk index -> index in raw (None: no web uri)
    for chunk in chunks:
        web = getattr(chunk, "web", None)
        uri = getattr(web, "uri", None) if web else None
        chunk_raw.append(len(raw) if uri else None)
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
    citations = _dedupe_citations(pairs, hints)
    chunk_urls = [resolved[i] if i is not None else None for i in chunk_raw]
    return _attach_spans(citations, resp.text or "", _gemini_spans(candidate, meta, resp.text or "", chunk_urls))


def _gemini_spans(candidate, meta, text: str, chunk_urls: list[str | None]) -> list[tuple[str, int, int]]:
    """(url, start, end) character offsets from Gemini's grounding_supports:
    each support is a segment of the answer plus the chunks backing it.
    Segment offsets are UTF-8 BYTES within one text part, not characters
    (verified live 2026-11-12: all 12 supports matched their segment.text
    only when read as bytes; read as characters every one after the first
    accented letter or curly quote would drift). Each segment is checked
    against the text Gemini says it covers; one that doesn't match is
    located by that text instead, or dropped."""
    parts = [p.text for p in (getattr(getattr(candidate, "content", None), "parts", None) or [])
             if getattr(p, "text", None) is not None and not getattr(p, "thought", False)]
    if "".join(parts) != text:  # resp.text is these parts joined; anything else, don't guess
        return []
    bases = [sum(len(p) for p in parts[:i]) for i in range(len(parts))]
    out = []
    for support in getattr(meta, "grounding_supports", None) or []:
        seg = getattr(support, "segment", None)
        if seg is None or seg.end_index is None:
            continue
        part = getattr(seg, "part_index", None) or 0
        if part >= len(parts):
            continue
        encoded = parts[part].encode("utf-8")
        start = bases[part] + len(encoded[:seg.start_index or 0].decode("utf-8", errors="ignore"))
        end = bases[part] + len(encoded[:seg.end_index].decode("utf-8", errors="ignore"))
        if seg.text and text[start:end] != seg.text:
            found = text.find(seg.text)
            if found < 0:
                continue
            start, end = found, found + len(seg.text)
        for idx in getattr(support, "grounding_chunk_indices", None) or []:
            if 0 <= idx < len(chunk_urls) and chunk_urls[idx]:
                out.append((chunk_urls[idx], start, end))
    return out


# --- Perplexity, Live Search only. Perplexity always searches the web before
# answering, so it has no Training Search equivalent and sits in PLATFORMS_LIVE
# only. Its Sonar Chat Completions API ended 2026-09-27; this uses the Agent
# API pinned to model perplexity/sonar (its `effort` presets route to OpenAI
# models, which would not be Perplexity's own answer). Request and response
# shape checked against a real call on 2026-11-11.

_PPLX_URL = "https://api.perplexity.ai/v1/agent"
_PPLX_MODEL_ID = "Perplexity (Sonar, live search)"  # "live search" tag: see src/lib/citations.ts
# Tier 1 allows 3 requests/second for the whole Perplexity account, and the
# pipeline starts up to PER_PROVIDER_CONCURRENCY calls at once, so request
# starts are spaced 0.4s apart (2.5/s). No lock needed: asyncio is single-
# threaded and the read-update below has no await in between.
_PPLX_MIN_INTERVAL = 0.4
_pplx_next_start = 0.0
_WEB_MARKER = re.compile(r"\[web:\d+\]")


async def _pplx_wait_turn() -> None:
    global _pplx_next_start
    now = time.monotonic()
    start = max(now, _pplx_next_start)
    _pplx_next_start = start + _PPLX_MIN_INTERVAL
    if start > now:
        await asyncio.sleep(start - now)


async def query_perplexity_live(prompt: str) -> PlatformResult:
    import httpx

    body = {
        "model": "perplexity/sonar",
        "instructions": _LIVE_SEARCH_SYSTEM_PROMPT,
        "input": prompt,
        "tools": [{"type": "web_search"}],
        "max_output_tokens": 4096,
    }
    headers = {"Authorization": f"Bearer {os.environ['PERPLEXITY_API_KEY']}"}
    last_err = ""
    for attempt in range(4):
        await _pplx_wait_turn()
        try:
            async with httpx.AsyncClient(timeout=120.0) as http:
                r = await http.post(_PPLX_URL, json=body, headers=headers)
        except httpx.HTTPError as e:
            last_err = f"{type(e).__name__}: {e}"
            await asyncio.sleep(5 * (attempt + 1))
            continue
        if r.status_code == 429:
            # request_rate_limit_exceeded / token_rate_limit_exceeded:
            # Retry-After is normally 1s, up to ~10s of jitter for tokens.
            last_err = f"429: {r.text[:300]}"
            try:
                wait = float(r.headers.get("retry-after", "1"))
            except ValueError:
                wait = 1.0
            await asyncio.sleep(min(max(wait, 1.0), 15.0))
            continue
        if r.status_code >= 500:
            last_err = f"{r.status_code}: {r.text[:300]}"
            await asyncio.sleep(5 * (attempt + 1))
            continue
        if r.status_code != 200:
            return PlatformResult(_PPLX_MODEL_ID, "", error=f"{r.status_code}: {r.text[:500]}")

        data = r.json()
        if data.get("status") == "failed" or data.get("error"):
            return PlatformResult(_PPLX_MODEL_ID, "", error=str(data.get("error") or "status failed"))
        texts, pairs = [], []
        for item in data.get("output") or []:
            if item.get("type") == "message":
                for block in item.get("content") or []:
                    if block.get("type") == "output_text":
                        texts.append(block.get("text") or "")
            elif item.get("type") == "search_results":
                for res in sorted(item.get("results") or [], key=lambda x: x.get("id") or 0):
                    pairs.append((res.get("url"), res.get("title") or ""))
        # Citations = every page in the answer's search_results, the list
        # Perplexity shows as Sources under each answer (the old Sonar API's
        # `citations` field was this same list). The answer text itself
        # carries no annotations, and in the 2026-11-11 test no [web:n]
        # markers either, only a model-written "Sources:" line whose URLs
        # can be mangled, so the text is not used for citations. Any
        # [web:n] markers are stripped so they can't break brand matching.
        text = _WEB_MARKER.sub("", "\n".join(t for t in texts if t)).strip()
        return PlatformResult(_PPLX_MODEL_ID, text, citations=_dedupe_citations(pairs))
    return PlatformResult(_PPLX_MODEL_ID, "", error=last_err or "Perplexity request failed")


PLATFORMS = {
    "openai": query_openai,
    "claude": query_claude,
    "gemini": query_gemini,
}

PLATFORMS_LIVE = {
    "openai": query_openai_live,
    "claude": query_claude_live,
    "gemini": query_gemini_live,
    "perplexity": query_perplexity_live,
}
