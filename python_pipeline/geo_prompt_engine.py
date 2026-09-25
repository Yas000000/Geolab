"""
GEO Prompt Generation Engine
Ported verbatim from geo-rank-checker/geo_prompt_engine.py. Generates exactly
25 GEO prompts from a client domain + priority services. Stays fully
synchronous -- the 7 category calls are deliberately NOT parallelized, since
_filter_and_score threads a seen_across_categories list across calls in call
order; parallelizing would make cross-category dedup order-dependent, a real
algorithm change, not just a speed one.
"""

import json
import os
import re
import time
from dataclasses import dataclass, field
import anthropic


CATEGORIES = [
    "best_top",
    "comparison",
    "who_offers",
    "recommendation_by_audience",
    "recommendation_by_constraint",
    "shortlist_vendor_selection",
    "location_based",
]

CATEGORY_TARGETS = {
    "best_top": 5,
    "comparison": 3,
    "who_offers": 3,
    "recommendation_by_audience": 4,
    "recommendation_by_constraint": 4,
    "shortlist_vendor_selection": 3,
    "location_based": 3,
}

CATEGORY_LABELS = {
    "best_top": "Best / Top",
    "comparison": "Comparison",
    "who_offers": "Who Offers",
    "recommendation_by_audience": "Recommendation by Audience",
    "recommendation_by_constraint": "Recommendation by Constraint",
    "shortlist_vendor_selection": "Shortlist / Vendor Selection",
    "location_based": "Location-Based",
}


@dataclass
class GeoPrompt:
    prompt_text: str
    category: str
    score: float
    reason: str


@dataclass
class GeoPromptGroup:
    category: str
    category_label: str
    prompts: list[GeoPrompt] = field(default_factory=list)


# NOTE: the negative lookahead below (`(?!.*\bvsb)`) is a known cosmetic bug
# carried over verbatim from the source -- it looks like it was meant to read
# `vs\b` (exempting "difference between X vs Y" phrasing from the informational
# filter) but as written it never actually matches "vs", so that exemption
# never fires in practice. Preserved as-is per the porting decision to not
# silently "fix" ported algorithm behavior.
INFORMATIONAL_PATTERNS = re.compile(
    r"\b(what is|what are|how does|how do|why is|explain|define|definition|"
    r"history of|overview of|tutorial|guide|learn|educate|training|"
    r"difference between\b(?!.*\bvsb))\b",
    re.IGNORECASE,
)

WEAK_PATTERNS = re.compile(
    r"\b(diy|yourself|template|checklist|sample|example|blog|article|"
    r"news|review of|reddit|forum|wikipedia|for fun|hobby)\b|near me",
    re.IGNORECASE,
)

# Verifies a "location_based" category candidate actually names a place, rather
# than trusting the LLM to follow the "include location signals" instruction --
# it frequently doesn't, especially for national/global SaaS services where
# "local provider" is an unnatural framing, and silently keeps the prompt in
# the bucket anyway. Three checks, any one is sufficient: (1) a preposition
# immediately followed by a capitalized place name ("in Chicago", "near
# Austin, TX", "serving the Bay Area"), (2) a common geography abbreviation
# used bare, without a preposition ("NYC agency for..."), (3) the literal
# --geography value passed in for this run.
_LOCATION_PREP_PATTERN = re.compile(
    r"\b(?:in|near|around|serving|based in|located in)\s+(?:the\s+)?"
    r"[A-Z][a-zA-Z]+(?:[\s\-.]+[A-Z][a-zA-Z]*){0,3}"
)
_GEO_ABBREVIATIONS = {"nyc", "sf", "la", "dc", "uk", "us", "usa", "eu", "bay area"}


def has_location_signal(prompt: str, geography: str = "") -> bool:
    p_lower = prompt.lower()
    if geography and geography.lower() in p_lower:
        return True
    if any(re.search(rf"\b{re.escape(abbr)}\b", p_lower) for abbr in _GEO_ABBREVIATIONS):
        return True
    return bool(_LOCATION_PREP_PATTERN.search(prompt))

HIGH_VALUE_SIGNALS = [
    "best", "top", "recommend", "hire", "shortlist", "compare",
    "which company", "which agency", "which firm", "should i use",
    "worth it", "alternatives to",
]

MEDIUM_VALUE_SIGNALS = [
    "who offers", "which provides", "vendor", "provider",
    "agency", "firm", "services",
]

SYSTEM_PROMPT = """You are a GEO (Generative Engine Optimization) strategist working for a B2B agency.

Your job is to generate prompts that real buyers type into AI tools (ChatGPT, Perplexity, Claude, Gemini)
when they are actively looking for a vendor, agency, or service provider.

The prompts you generate must:
- Be unbranded (no company names)
- Trigger vendor recommendations, comparisons, or shortlists from AI tools
- Reflect real buyer behavior at the commercial investigation or decision stage
- Be commercially oriented — the person is about to hire someone or make a purchase
- Be specific to the service being searched
- Be concise and conversational — aim for 6 to 12 words, like something someone would naturally type
- Focus on ONE need or constraint per prompt — do not stack multiple requirements with "and" or "with"

The prompts must NOT:
- Be informational or educational ("what is...", "how does...", "explain...")
- Be awareness-stage queries
- Include brand names
- Be generic filler
- Be run-on sentences cramming multiple qualifiers together

Output only valid JSON, no commentary."""


def passes_filters(prompt: str, allow_terms: set[str] | None = None) -> tuple[bool, str]:
    allow_terms = allow_terms or set()
    if INFORMATIONAL_PATTERNS.search(prompt):
        return False, "informational intent"
    for m in WEAK_PATTERNS.finditer(prompt):
        if m.group(0).lower() not in allow_terms:
            return False, "weak/non-commercial prompt"
    if len(prompt.strip().split()) < 5:
        return False, "too short"
    return True, "passed"


def is_branded(prompt: str, brand_tokens: set[str]) -> bool:
    p_lower = prompt.lower()
    return any(token in p_lower for token in brand_tokens)


def score_prompt(prompt: str) -> float:
    p_lower = prompt.lower()
    score = 0.5
    for sig in HIGH_VALUE_SIGNALS:
        if sig in p_lower:
            score += 0.25
            break
    for sig in MEDIUM_VALUE_SIGNALS:
        if sig in p_lower:
            score += 0.10
            break
    word_count = len(p_lower.split())
    if 6 <= word_count <= 12:
        score += 0.10
    elif word_count > 15:
        score -= 0.15
    elif word_count <= 4:
        score -= 0.05
    return min(round(score, 2), 1.0)


def build_generation_prompt(service, domain, context, category, target_count):
    audience = context.get("target_audience", "businesses")
    geography = context.get("target_geography", "")
    geo_str = f" in {geography}" if geography else ""
    brevity_rule = (
        "Keep each prompt to 6-12 words. One idea per prompt - do not stack multiple "
        "qualifiers with 'and' or 'with'. Write naturally, like a real person typing into ChatGPT."
    )
    category_instructions = {
        "best_top": (
            f'Generate {target_count} short prompts a buyer would type to find the best or top providers '
            f'of {service}{geo_str}. Start prompts with "best", "top", "leading", etc. {brevity_rule}'
        ),
        "comparison": (
            f'Generate {target_count} short prompts a buyer would type to compare providers '
            f'for {service}. Use "vs", "compare", or "alternatives to" style phrasing. {brevity_rule}'
        ),
        "who_offers": (
            f'Generate {target_count} short prompts a buyer would type asking which companies '
            f'offer {service}{geo_str}. Start with "who offers", "which companies", "where can I find", etc. {brevity_rule}'
        ),
        "recommendation_by_audience": (
            f'Generate {target_count} short prompts tailored to specific buyer types ({audience}) '
            f'seeking {service}. Include the audience type naturally. {brevity_rule}'
        ),
        "recommendation_by_constraint": (
            f'Generate {target_count} short prompts from buyers with a single specific constraint '
            f'when seeking {service} - one constraint only per prompt. {brevity_rule}'
        ),
        "shortlist_vendor_selection": (
            f'Generate {target_count} short prompts a buyer would type when making a final vendor '
            f'decision for {service}. Use "shortlist", "which should I use", "best option for", etc. {brevity_rule}'
        ),
        "location_based": (
            f'Generate {target_count} short prompts a buyer would type to find a local or regional provider '
            f'of {service}{geo_str}. Include location signals. {brevity_rule}'
        ),
    }
    kickoff_notes = context.get("kickoff_notes", "").strip()
    kickoff_block = (
        f"\n\nCAMPAIGN KICKOFF NOTES:\n{kickoff_notes}\n" if kickoff_notes else ""
    )
    instruction = category_instructions[category]
    return f"""{instruction}

Target audience: {audience}{kickoff_block}

Return ONLY this JSON:
{{
  "prompts": [
    "prompt text one",
    "prompt text two"
  ]
}}"""


class GeoPromptEngine:

    def __init__(self):
        self.client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    def generate(self, domain: str, priority_services: list[str], context: dict | None = None) -> list[GeoPromptGroup]:
        context = context or {}
        brand_tokens = self._extract_brand_tokens(domain)
        allow_terms = {t.lower() for t in context.get("allow_terms", []) or []}
        service_description = " and ".join(priority_services)
        geography = context.get("target_geography", "")
        groups = []
        # Each category is generated via an independent LLM call, and the category
        # instructions overlap enough (e.g. "best_top" and "recommendation_by_audience"
        # both ask for "best X for Y" style phrasing) that the model can produce the
        # literal same prompt text in two different categories. _deduplicate() only
        # ever saw one category's candidates at a time, so that collision went
        # uncaught -- tracked here across the whole generate() call instead.
        seen_across_categories: list[str] = []
        for category in CATEGORIES:
            target = CATEGORY_TARGETS[category]
            candidates = self._generate_candidates(service_description, domain, context, category, target * 3)
            group = self._filter_and_score(candidates, category, brand_tokens, target, allow_terms, geography,
                                            seen_across_categories)
            groups.append(group)
        return self._enforce_25(groups)

    def _generate_candidates(self, service, domain, context, category, target_count):
        prompt = build_generation_prompt(service, domain, context, category, target_count)
        for attempt in range(4):
            try:
                message = self.client.messages.create(
                    model="claude-opus-4-6",
                    max_tokens=1024,
                    system=SYSTEM_PROMPT,
                    messages=[{"role": "user", "content": prompt}],
                )
                break
            except Exception as e:
                if any(code in str(e) for code in ("529", "500")) or any(w in str(e).lower() for w in ("overloaded", "internal server")):
                    wait = 10 * (attempt + 1)
                    print(f"    API overloaded, retrying in {wait}s...")
                    time.sleep(wait)
                else:
                    raise
        else:
            return []
        raw_text = message.content[0].text.strip()
        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
        raw_text = re.sub(r"\s*```$", "", raw_text)
        try:
            data = json.loads(raw_text)
            return [p.strip() for p in data.get("prompts", []) if isinstance(p, str)]
        except json.JSONDecodeError:
            return []

    def _filter_and_score(self, candidates, category, brand_tokens, target, allow_terms=None, geography="",
                           seen_across_categories=None):
        scored = []
        for prompt_text in candidates:
            if not prompt_text:
                continue
            passed, reason = passes_filters(prompt_text, allow_terms)
            if not passed:
                continue
            if is_branded(prompt_text, brand_tokens):
                continue
            if category == "location_based" and not has_location_signal(prompt_text, geography):
                continue
            score = score_prompt(prompt_text)
            scored.append(GeoPrompt(prompt_text=prompt_text, category=category, score=score, reason=reason))
        scored = self._deduplicate(scored, seen_across_categories)
        scored.sort(key=lambda p: p.score, reverse=True)
        kept = scored[:target]
        if seen_across_categories is not None:
            seen_across_categories.extend(p.prompt_text.lower().strip() for p in kept)
        return GeoPromptGroup(category=category, category_label=CATEGORY_LABELS[category], prompts=kept)

    def _deduplicate(self, prompts, seen_across_categories=None):
        seen = list(seen_across_categories) if seen_across_categories else []
        unique = []
        for p in prompts:
            normalized = p.prompt_text.lower().strip()
            if not any(normalized in s or s in normalized for s in seen):
                seen.append(normalized)
                unique.append(p)
        return unique

    def _enforce_25(self, groups):
        total = sum(len(g.prompts) for g in groups)
        if total > 25:
            excess = total - 25
            groups_sorted = sorted(groups, key=lambda g: sum(p.score for p in g.prompts) / max(len(g.prompts), 1))
            for group in groups_sorted:
                if excess == 0:
                    break
                while len(group.prompts) > 1 and excess > 0:
                    group.prompts.pop()
                    excess -= 1
        return groups

    def _extract_brand_tokens(self, domain):
        domain = re.sub(r"https?://", "", domain).split("/")[0]
        domain = re.sub(r"\.(com|net|org|io|co|us|uk)$", "", domain)
        tokens = re.split(r"[\-\.]", domain.lower())
        return {t for t in tokens if len(t) >= 7}
