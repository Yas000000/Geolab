"""
Extracts a clean, ranked list of brand/company names mentioned in each AI response.

Ported from geo-rank-checker/brand_extractor.py. The source runs its 15-response
batches through the Anthropic API sequentially, one `for` loop iteration at a
time; this version gathers all batches concurrently via `asyncio.gather` instead,
since batches have no cross-batch state dependency (unlike geo_prompt_engine.py's
category calls) -- a safe, speed-only deviation. The per-batch try/except is
preserved so one bad batch doesn't fail the others, matching the source's
"partial results survive" behavior. Last synced 2026-11-06 (through
geo-rank-checker dba814e).
"""

import asyncio
import json
import os

import anthropic

_client: anthropic.AsyncAnthropic | None = None
BATCH_SIZE = 15

_SYSTEM = (
    "You extract brand and company names from AI-generated answers. "
    "Return only valid JSON."
)

_PROMPT = """\
For each AI response below, extract every distinct company, brand, or product name that
is recommended or listed as an option for the buyer's question. List them in the order
they are ranked or first mentioned. Do not include generic terms, materials, or
descriptive phrases -- only actual company/brand/product names. Do not include investors,
backers, parent companies or partners that are only mentioned while describing another
option (e.g. "LangChain - Backed by Sequoia Capital" gives LangChain, not Sequoia Capital).

Responses to analyze (JSON array -- "response" truncated to 2000 chars):
{responses_json}

Return ONLY valid JSON with no prose or markdown fencing:
{{
  "results": [
    {{"index": <int, 0-based index matching input>, "brands": ["Brand One", "Brand Two", ...]}}
  ]
}}
If a response names no companies/brands, return an empty array for "brands".
"""


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    return _client


async def _run_batch(batch: list[dict], result_map: dict, batch_num: int) -> None:
    client = _get_client()
    # Index the payload locally (0-based within THIS batch), not by each item's
    # global position. Synced from geo-rank-checker 86e1889: a batch sent with
    # global indices (e.g. 15-29) came back renumbered from 0 on a real run, so
    # none matched index_map and the whole batch was silently dropped.
    payload = [{"index": i, "response": it["response"]} for i, it in enumerate(batch)]
    prompt_text = _PROMPT.format(responses_json=json.dumps(payload, ensure_ascii=False, indent=2))

    try:
        msg = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=4096,
            # Deterministic (synced from geo-rank-checker dba814e) -- otherwise the
            # same answer can yield different brand names run to run, which this
            # portal would show as competitors moving when nothing changed.
            # Sent via extra_body: anthropic SDK 1.x (what Vercel installs from
            # requirements.txt) dropped the `temperature` keyword and raises on
            # it, failing every batch. The API itself still reads the field
            # for this model (checked 2026-11-06: a 0..1 range error on 7).
            extra_body={"temperature": 0},
            system=_SYSTEM,
            messages=[{"role": "user", "content": prompt_text}],
        )
        raw = msg.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        parsed = json.loads(raw)
        index_map = {i: it for i, it in enumerate(batch)}

        matched = set()
        for entry in parsed.get("results", []):
            original = index_map.get(entry.get("index"))
            if not original:
                continue
            matched.add(entry.get("index"))
            brands = [b.strip() for b in entry.get("brands", []) if b and b.strip()]
            result_map[(original["platform"], original["prompt"])] = brands

        missing = len(batch) - len(matched)
        if missing:
            print(f"[brand_extractor] Batch {batch_num}: {missing}/{len(batch)} items had no matching index in the model's response")

    except Exception as exc:
        print(f"[brand_extractor] Batch {batch_num} error: {exc}")


async def extract_brands(raw_responses: dict) -> dict:
    """
    Args:
        raw_responses: {platform_name: {prompt_text: response_text}}

    Returns:
        {(platform_name, prompt_text): [brand_name, ...]} -- ranked brand names per response.
        Missing/failed entries are simply absent from the returned dict.
    """
    items = []
    for platform, prompt_map in raw_responses.items():
        for prompt_text, response_text in prompt_map.items():
            if response_text and response_text.strip():
                items.append({
                    "platform": platform,
                    "prompt": prompt_text,
                    "response": response_text[:2000],
                })

    result_map: dict = {}
    if not items:
        return result_map

    batches = [items[i : i + BATCH_SIZE] for i in range(0, len(items), BATCH_SIZE)]
    await asyncio.gather(*(
        _run_batch(batch, result_map, i + 1) for i, batch in enumerate(batches)
    ))

    return result_map
