"""
Parses an AI response to detect brand mentions, rank position, and sentiment.
Ported verbatim from geo-rank-checker/parser.py -- pure regex/string logic,
no I/O, no reason to change behavior during the port.
"""

import re
from dataclasses import dataclass, field


@dataclass
class MentionResult:
    mentioned: bool
    rank: int | None            # numbered position in AI list, or None
    sentiment: str              # "positive" / "neutral" / "negative" / "n/a"
    excerpt: str
    brands_in_response: list = field(default_factory=list)  # [(name, rank_or_None), ...]
    top_items: list = field(default_factory=list)           # [(rank, label), ...] top 5 from AI list


def analyze(response: str, brand: str, competitors: list = None) -> MentionResult:
    if not response:
        return MentionResult(False, None, "n/a", "", [], [])

    competitors = competitors or []
    all_brands = [brand] + competitors
    numbered_items = _extract_numbered_items(response)
    brands_in_response = _find_brands_in_response(response, all_brands, numbered_items)
    top_items = _extract_top_items(numbered_items, n=5)

    brand_pattern = re.compile(re.escape(brand), re.IGNORECASE)
    brand_match = brand_pattern.search(response)
    if not brand_match:
        return MentionResult(False, None, "n/a", "", brands_in_response, top_items)

    rank = _find_brand_rank(numbered_items, brand)
    if rank is None:
        rank = _find_position_rank(response, brand, competitors)

    # If the brand isn't already in top_items (it was mentioned in prose, not in the
    # numbered list), inject it at the position matching where it first appears in text.
    brand_in_top = any(
        re.search(re.escape(brand), label, re.IGNORECASE)
        for _, label in top_items
    )
    if not brand_in_top:
        brand_pos = brand_match.start()
        insert_at = len(top_items)  # default: append
        for i, (_, label) in enumerate(top_items):
            key = label[:15].strip()
            if key:
                item_m = re.search(re.escape(key), response, re.IGNORECASE)
                if item_m and brand_pos < item_m.start():
                    insert_at = i
                    break
        top_items = list(top_items)
        top_items.insert(insert_at, (rank, brand))
        top_items = top_items[:5]

    excerpt = _extract_excerpt(response, brand)
    sentiment = _detect_sentiment(excerpt)

    return MentionResult(True, rank, sentiment, excerpt, brands_in_response, top_items)


def _extract_numbered_items(text: str) -> dict:
    """Returns {rank_int: item_text} for numbered or bulleted list entries.

    Ranks are assigned sequentially in document order rather than trusting the
    literal number printed in the text. A response formatted as multiple tiered
    lists (e.g. "## Enterprise-Level" 1-5 followed by "## Mid-Market Specialists"
    1-5) would otherwise have the second list's "1." silently overwrite the
    first list's "1." in the dict, since both parse to the same key -- corrupting
    labels/descriptions for any keys that collide.
    """
    items = {}
    bullet_items = []
    seq = 0

    for line in text.split('\n'):
        clean = re.sub(r'\*+', '', line).strip()
        # Markdown headings ("### 1. ShipBob") -- strip the leading "#"s so the
        # numbered-item match below still fires instead of falling through to
        # the sub-bullet lines underneath being mistaken for the ranked list.
        clean = re.sub(r'^#+\s*', '', clean)

        # Numbered: "1. text" or "1) text"
        m = re.match(r'^(\d+)[.)]\s+(.+)', clean)
        if m:
            seq += 1
            items[seq] = m.group(2).strip()
            continue

        # Bullet: "- text", "* text", "• text" (treat order as rank)
        m = re.match(r'^[-*•]\s+(.+)', clean)
        if m:
            bullet_items.append(m.group(1).strip())

    # Use bullet order as rank only when no numbered list was found
    if bullet_items and not items:
        for i, item_text in enumerate(bullet_items, 1):
            items[i] = item_text

    return items


def _find_brand_rank(numbered_items: dict, brand: str) -> int | None:
    # Stage 1: brand name leads the item exactly
    for rank, text in sorted(numbered_items.items()):
        if re.match(re.escape(brand), text.strip(), re.IGNORECASE):
            return rank
    # Stage 2: brand name appears as a substring within the first 80 chars
    for rank, text in sorted(numbered_items.items()):
        if re.search(re.escape(brand), text.strip()[:80], re.IGNORECASE):
            return rank
    # Stage 3: all words of the brand appear in the first 80 chars
    # catches "Thrive Agency" inside "Thrive Internet Marketing Agency"
    brand_words = re.findall(r'\w+', brand.lower())
    for rank, text in sorted(numbered_items.items()):
        lead = text.strip()[:80].lower()
        if all(word in lead for word in brand_words):
            return rank
    return None


def _find_brands_in_response(text: str, brands: list, numbered_items: dict) -> list:
    """Returns [(brand_name, rank_or_None), ...] ordered by rank then text position."""
    found = []
    for brand in brands:
        pattern = re.compile(re.escape(brand), re.IGNORECASE)
        match = pattern.search(text)
        if not match:
            continue
        rank = _find_brand_rank(numbered_items, brand)
        found.append((brand, rank, match.start()))

    found.sort(key=lambda x: (x[1] if x[1] is not None else 999, x[2]))
    return [(name, rank) for name, rank, _ in found]


def _extract_top_items(numbered_items: dict, n: int = 5) -> list:
    """Returns [(rank, brand_label), ...] for the top N items in the numbered list."""
    items = []
    for rank in sorted(numbered_items.keys())[:n]:
        text = numbered_items[rank]
        # Strip description after common separators — keep just the brand/company name.
        # Must include the em dash (—, U+2014): that's what Claude/GPT actually emit in
        # "Brand — description" list items, and a plain hyphen/en-dash class silently
        # misses it, leaving the whole truncated "Brand — descrip..." line as the label.
        # Plain hyphen/en-dash only split when real whitespace surrounds them -- without
        # that requirement, a mid-word hyphen ("Flat-Fee", "V-VICTA", "de-escalation")
        # gets treated as a separator too, truncating the label mid-word ("Consider a
        # Flat-Fee MLS Service" -> "Consider a Flat"). Em dash/colon/pipe still split
        # freely since those are never used mid-word.
        label = re.split(r'\s+[-–]\s+|\s*[—:|]\s*', text)[0].strip()
        # Trim markdown bold leftovers and cap length
        label = re.sub(r'\*+', '', label).strip()[:60]
        items.append((rank, label))
    return items


def _find_position_rank(text: str, brand: str, competitors: list) -> int | None:
    """Rank by order of first appearance in text when no numbered list rank exists."""
    all_brands = [brand] + competitors
    positions = {}
    for b in all_brands:
        m = re.search(re.escape(b), text, re.IGNORECASE)
        if m:
            positions[b] = m.start()
    if brand not in positions:
        return None
    sorted_brands = sorted(positions, key=lambda b: positions[b])
    return sorted_brands.index(brand) + 1


def _extract_excerpt(response: str, brand: str) -> str:
    """Returns the sentence that first mentions the brand plus the sentence
    immediately after it -- widened from a single sentence so _detect_sentiment
    has more context to work with (tone is often carried into the following
    sentence rather than the one that just names the brand, e.g. "Fieldpoint
    Equity specializes in X. Their team is highly experienced.") and so the
    excerpt itself reads as a more representative quote in the report."""
    pattern = re.compile(re.escape(brand), re.IGNORECASE)
    sentences = re.split(r'(?<=[.!?])\s+', response)
    for i, sentence in enumerate(sentences):
        if pattern.search(sentence):
            window = sentences[i:i + 2]
            return ' '.join(s.strip() for s in window if s.strip())
    return ""


_POSITIVE_WORDS = {
    "best", "top", "leading", "excellent", "great", "highly", "recommended", "recommend",
    "recommends", "trusted", "trustworthy", "popular", "award", "award-winning", "expert",
    "expertise", "experienced", "knowledgeable", "skilled", "qualified", "premier",
    "outstanding", "strong", "solid", "reputable", "reputation", "established", "credible",
    "credibility", "reliable", "legitimate", "specialize", "specializes", "specializing",
    "specialized", "specialization", "innovative", "comprehensive", "competitive",
    "favorable", "impressive", "notable", "prominent", "exceptional", "superior",
    "advantageous", "beneficial", "respected", "renowned", "proven", "effective",
    "efficient", "personalized", "tailored", "unique", "helpful", "flexible"
}
_NEGATIVE_WORDS = {
    "avoid", "poor", "worst", "bad", "mediocre", "disappointing", "unreliable",
    "overpriced", "slow", "complaint", "complaints", "issue", "issues", "problem",
    "problems", "scam", "warning", "risky", "risk", "questionable", "controversial",
    "controversy", "lawsuit", "lawsuits", "fraud", "fraudulent", "penalized", "penalty",
    "fined", "fine", "violation", "violations", "misleading", "deceptive",
    "inexperienced", "lacking", "concerning", "concerns", "unqualified", "unproven",
    "unverified", "sketchy", "unclear", "confusing"
}


def _detect_sentiment(text: str) -> str:
    if not text:
        return "neutral"
    words = set(re.findall(r'\b\w+\b', text.lower()))
    pos = words & _POSITIVE_WORDS
    neg = words & _NEGATIVE_WORDS
    if pos and not neg:
        return "positive"
    if neg and not pos:
        return "negative"
    return "neutral"
