import asyncio
import traceback

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from python_pipeline.geo_prompt_engine import CATEGORY_LABELS, GeoPromptEngine
from python_pipeline.platforms import PLATFORMS, PLATFORMS_LIVE, PlatformResult
from python_pipeline.parser import analyze, normalize_text
from python_pipeline.brand_extractor import extract_brands
from python_pipeline.internal_key import require_internal_key

app = FastAPI()
require_internal_key(app)  # only the portal itself may call this

DEFAULT_PLATFORMS = ["openai", "claude", "gemini"]
# Perplexity always searches the web, so it has no Training Search mode and
# only joins Live Search runs (python_pipeline/platforms.py).
DEFAULT_PLATFORMS_LIVE = DEFAULT_PLATFORMS + ["perplexity"]
# Raised from 5 -- confirmed live (2026-10-12) that a real Live Search run
# (55 prompts, concurrency 5) exceeded this route's 300s maxDuration and got
# hard-killed by the platform before completing (Training Search on the same
# 55 prompts finished in ~140s at the old concurrency, so Live Search's real
# web-search round-trips are the bottleneck, not raw model latency). Higher
# concurrency directly cuts the number of sequential batches per platform
# (55 prompts / N concurrent); no evidence yet this trips provider rate
# limits, but per-call errors are already handled gracefully if it does.
PER_PROVIDER_CONCURRENCY = 15
DEFAULT_CATEGORY = "general"


class PromptInput(BaseModel):
    text: str
    category: str | None = None
    # The client's locations (LocationInput ids) this prompt is tracked in;
    # Live Search asks it once per location. Empty: once, with no location.
    locationIds: list[str] | None = None


class LocationInput(BaseModel):
    id: str
    label: str  # the place name the engines are told to search for: "Canada"
    country: str  # ISO 3166-1 alpha-2
    region: str | None = None
    city: str | None = None


class RunPipelineRequest(BaseModel):
    domain: str
    brand: str
    services: list[str] = []
    prompts: list[PromptInput] | None = None
    audience: str | None = None
    geography: str | None = None
    kickoff_notes: str | None = None
    competitors: list[str] | None = None
    # Other exact names the client may be mentioned under -- any match counts
    # as the client, always reported under `brand` (parser.analyze()).
    aliases: list[str] | None = None
    platforms: list[str] | None = None
    live_search: bool = False
    # The client's locations, for prompts' locationIds (Live Search only:
    # Training Search answers from memory, so it ignores locations).
    locations: list[LocationInput] | None = None


def _category_label(category: str) -> str:
    return CATEGORY_LABELS.get(category, category.replace("_", " ").replace("-", " ").title())


def _build_manual_prompt_groups(prompts: list[PromptInput]) -> tuple[list, list]:
    """Skips Stage 1 generation entirely -- builds the same promptGroups/
    flat_prompts shape Stage 1 would, straight from operator-supplied text.
    Exact-duplicate (category, text) pairs are dropped (keeping first
    occurrence) so extract_brands()'s text-keyed internal dict (see its call
    site below) can never silently collide two different prompts' responses
    -- the auto-gen path gets this guarantee for free from geo_prompt_engine's
    own cross-category dedup; manual paste has no such guarantee, so it's
    enforced here instead.
    """
    seen: set[tuple[str, str]] = set()
    ordered: list[dict] = []
    for p in prompts:
        category = (p.category or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
        text = p.text.strip()
        if not text:
            continue
        key = (category.lower(), text.lower())
        if key in seen:
            continue
        seen.add(key)
        ordered.append({"category": category, "text": text, "locationIds": list(p.locationIds or [])})

    groups_by_category: dict[str, list[dict]] = {}
    for item in ordered:
        groups_by_category.setdefault(item["category"], []).append(item)

    prompt_groups_out = []
    flat_prompts = []
    position = 0
    for category, items in groups_by_category.items():
        group_prompts_out = []
        for item in items:
            position += 1
            flat_prompts.append({
                "position": position,
                "category": category,
                "text": item["text"],
                "locationIds": item["locationIds"],
            })
            group_prompts_out.append({
                "text": item["text"],
                "score": None,
                "reason": "manual",
                "position": position,
                "locationIds": item["locationIds"],
            })
        prompt_groups_out.append({
            "category": category,
            "categoryLabel": _category_label(category),
            "prompts": group_prompts_out,
        })
    return prompt_groups_out, flat_prompts


@app.post("/api/run_pipeline")
async def run_pipeline(payload: RunPipelineRequest) -> dict:
    platform_registry = PLATFORMS_LIVE if payload.live_search else PLATFORMS
    platforms_requested = payload.platforms or (DEFAULT_PLATFORMS_LIVE if payload.live_search else DEFAULT_PLATFORMS)
    selected = {k: platform_registry[k] for k in platforms_requested if k in platform_registry}
    generation_warnings = []
    live_only = [k for k in platforms_requested if k not in platform_registry and k in PLATFORMS_LIVE]
    if live_only:
        generation_warnings.append(f"Live Search only, skipped in Training Search: {', '.join(live_only)}")
    unknown = [k for k in platforms_requested if k not in platform_registry and k not in PLATFORMS_LIVE]
    if unknown:
        generation_warnings.append(f"Unknown platform(s) ignored: {', '.join(unknown)}")

    if payload.prompts:
        # Manual prompts supplied -- skip Stage 1 (LLM generation) entirely.
        prompt_groups_out, flat_prompts = _build_manual_prompt_groups(payload.prompts)
    elif payload.services:
        context = {
            "target_audience": payload.audience or "businesses",
            "target_geography": payload.geography or "",
            "kickoff_notes": payload.kickoff_notes or "",
            # With no location given, the Location-Based instruction still
            # demands a regional signal and the model invents one (e.g. "the
            # Southeast" for a nationwide client) -- same rule the proposal
            # generator follows. Its 3 slots go to other categories.
            "include_location_prompts": bool((payload.geography or "").strip()),
        }
        # Stage 1: prompt generation. geo_prompt_engine.py's generate() is
        # deliberately kept synchronous/sequential (see that module's docstring
        # -- parallelizing the 7 category calls would make cross-category dedup
        # order-dependent). Run it off the event loop thread since it's a
        # series of blocking HTTP calls.
        engine = GeoPromptEngine()
        groups = await asyncio.to_thread(
            engine.generate, payload.domain, payload.services, context
        )

        # Flatten to a global 1..25 position, and build the promptGroups
        # response shape in the same pass. Every downstream stage of THIS
        # orchestration keys results by position, not prompt text -- a
        # duplicate/near-duplicate prompt string can never collide two
        # results together this way (the exact storage-layer bug class
        # documented elsewhere in this tool family, e.g. geo-proposal-
        # generator's Foodvisor incident).
        prompt_groups_out = []
        flat_prompts = []
        position = 0
        for group in groups:
            group_prompts_out = []
            for p in group.prompts:
                position += 1
                flat_prompts.append({
                    "position": position,
                    "category": group.category,
                    "text": p.prompt_text,
                })
                group_prompts_out.append({
                    "text": p.prompt_text,
                    "score": p.score,
                    "reason": p.reason,
                    "position": position,
                })
            prompt_groups_out.append({
                "category": group.category,
                "categoryLabel": group.category_label,
                "prompts": group_prompts_out,
            })
    else:
        raise HTTPException(status_code=400, detail="Provide either 'prompts' or a non-empty 'services' list.")

    # Stage 2: concurrent platform queries, one semaphore per provider so a
    # slow/rate-limited provider can't starve the others.
    semaphores = {name: asyncio.Semaphore(PER_PROVIDER_CONCURRENCY) for name in selected}

    async def run_one(prompt_entry: dict, platform_key: str, query_fn, location: dict | None) -> dict:
        async with semaphores[platform_key]:
            try:
                result = await (query_fn(prompt_entry["text"], location) if location else query_fn(prompt_entry["text"]))
            except Exception as e:
                # Each query function returns its own API errors as a result,
                # but anything that escapes one (2026-11-12: `import httpx`
                # failing once a deploy stopped installing it) would make
                # gather() fail the WHOLE run, every platform, after 3s.
                # Kept to this one answer instead, and logged with traceback
                # since Vercel shows no traceback for a 500.
                traceback.print_exc()
                label = f"{platform_key} (live search)" if payload.live_search else platform_key
                result = PlatformResult(label, "", error=f"{type(e).__name__}: {e}")
        parsed = analyze(result.response, payload.brand, payload.competitors or [], payload.aliases or [])
        return {
            "promptPosition": prompt_entry["position"],
            "promptText": prompt_entry["text"],
            "category": prompt_entry["category"],
            "platform": platform_key,
            "locationId": location["id"] if location else None,
            "modelId": result.platform,
            "responseText": result.response,
            "error": result.error,
            "citations": result.citations,
            "parsed": {
                "mentioned": parsed.mentioned,
                "rank": parsed.rank,
                "sentiment": parsed.sentiment,
                "excerpt": parsed.excerpt,
                "brandsInResponse": parsed.brands_in_response,
                "topItems": parsed.top_items,
                "extractedBrands": [],  # filled in after Stage 3 below
            },
        }

    # Live Search asks a prompt once per location it's tracked in (an id not
    # among the request's locations is skipped); otherwise once, with none.
    locations_by_id = {loc.id: loc.model_dump() for loc in (payload.locations or [])}

    def where(prompt_entry: dict) -> list[dict | None]:
        if not payload.live_search:
            return [None]
        located = [locations_by_id[i] for i in prompt_entry.get("locationIds") or [] if i in locations_by_id]
        return located or [None]

    tasks = [
        run_one(prompt_entry, platform_key, query_fn, location)
        for prompt_entry in flat_prompts
        for location in where(prompt_entry)
        for platform_key, query_fn in selected.items()
    ]
    results = await asyncio.gather(*tasks)

    # Stage 3: brand extraction. extract_brands() needs its existing
    # {platform: {prompt_text: response_text}} contract -- safe to key by
    # text here because both prompt sources guarantee no duplicate prompt
    # text reaches this point: geo_prompt_engine.py's own cross-category
    # dedup for the auto-gen path, _build_manual_prompt_groups()'s explicit
    # dedup above for the manual path.
    # Text is unicode-folded first (non-breaking hyphens/spaces, which live-
    # search answers use) so "Smith & Nephew" can't come back as a
    # different brand name from "Smith & Nephew" -- synced from
    # geo-rank-checker fc1d911. The stored responseText stays as returned.
    # The same prompt asked in several locations is one answer per location,
    # so the location is part of the platform key here (it's only a key).
    def extraction_key(r: dict) -> str:
        return f'{r["platform"]}@{r["locationId"]}' if r["locationId"] else r["platform"]

    raw_responses_by_platform: dict[str, dict[str, str]] = {}
    for r in results:
        raw_responses_by_platform.setdefault(extraction_key(r), {})[r["promptText"]] = normalize_text(r["responseText"])

    extracted = await extract_brands(raw_responses_by_platform)
    for r in results:
        key = (extraction_key(r), r["promptText"])
        r["parsed"]["extractedBrands"] = extracted.get(key, [])

    return {
        "promptGroups": prompt_groups_out,
        "results": results,
        "meta": {
            "totalPrompts": len(flat_prompts),
            "platformsQueried": list(selected.keys()),
            "generationWarnings": generation_warnings,
        },
    }
