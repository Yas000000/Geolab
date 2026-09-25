import asyncio

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from python_pipeline.geo_prompt_engine import CATEGORY_LABELS, GeoPromptEngine
from python_pipeline.platforms import PLATFORMS
from python_pipeline.parser import analyze
from python_pipeline.brand_extractor import extract_brands

app = FastAPI()

DEFAULT_PLATFORMS = ["openai", "claude", "gemini"]
PER_PROVIDER_CONCURRENCY = 5
DEFAULT_CATEGORY = "general"


class PromptInput(BaseModel):
    text: str
    category: str | None = None


class RunPipelineRequest(BaseModel):
    domain: str
    brand: str
    services: list[str] = []
    prompts: list[PromptInput] | None = None
    audience: str | None = None
    geography: str | None = None
    kickoff_notes: str | None = None
    competitors: list[str] | None = None
    platforms: list[str] | None = None


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
        ordered.append({"category": category, "text": text})

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
            })
            group_prompts_out.append({
                "text": item["text"],
                "score": None,
                "reason": "manual",
                "position": position,
            })
        prompt_groups_out.append({
            "category": category,
            "categoryLabel": _category_label(category),
            "prompts": group_prompts_out,
        })
    return prompt_groups_out, flat_prompts


@app.post("/api/run_pipeline")
async def run_pipeline(payload: RunPipelineRequest) -> dict:
    platforms_requested = payload.platforms or DEFAULT_PLATFORMS
    selected = {k: PLATFORMS[k] for k in platforms_requested if k in PLATFORMS}
    generation_warnings = []
    unknown = [k for k in platforms_requested if k not in PLATFORMS]
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

    async def run_one(prompt_entry: dict, platform_key: str, query_fn) -> dict:
        async with semaphores[platform_key]:
            result = await query_fn(prompt_entry["text"])
        parsed = analyze(result.response, payload.brand, payload.competitors or [])
        return {
            "promptPosition": prompt_entry["position"],
            "promptText": prompt_entry["text"],
            "category": prompt_entry["category"],
            "platform": platform_key,
            "modelId": result.platform,
            "responseText": result.response,
            "error": result.error,
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

    tasks = [
        run_one(prompt_entry, platform_key, query_fn)
        for prompt_entry in flat_prompts
        for platform_key, query_fn in selected.items()
    ]
    results = await asyncio.gather(*tasks)

    # Stage 3: brand extraction. extract_brands() needs its existing
    # {platform: {prompt_text: response_text}} contract -- safe to key by
    # text here because both prompt sources guarantee no duplicate prompt
    # text reaches this point: geo_prompt_engine.py's own cross-category
    # dedup for the auto-gen path, _build_manual_prompt_groups()'s explicit
    # dedup above for the manual path.
    raw_responses_by_platform: dict[str, dict[str, str]] = {name: {} for name in selected}
    for r in results:
        raw_responses_by_platform[r["platform"]][r["promptText"]] = r["responseText"]

    extracted = await extract_brands(raw_responses_by_platform)
    for r in results:
        key = (r["platform"], r["promptText"])
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
