"""
Is the client on this page? The listing check for one cited page's HTML, shared by the
server's checks (python_pipeline/outreach.py) and the Outreach Helper that re-checks blocked
pages in real Chrome on the user's PC (helper/outreach_helper.py), so both read a page the
same way. Needs only BeautifulSoup.
"""

import re
from urllib.parse import urlsplit, urlunsplit

from bs4 import BeautifulSoup

_BLOCK_MARKERS = re.compile(r"just a moment|verify you are human|access denied|attention required|"
                            r"are you a robot|checking your browser|enable javascript and cookies", re.I)


def looks_blocked(html: str) -> bool:
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


def is_site_itself(name: str, site_domain: str) -> bool:
    """Either name contains the other: "Clutch" on clutch.co, "O'Dwyer's" on odwyerpr.com."""
    site_key = re.sub(r"[^a-z0-9]", "", site_domain.split(".")[0])
    dotless = re.sub(r"[^a-z0-9]", "", site_domain.rsplit(".", 1)[0]) if site_domain.count(".") == 1 else site_key
    trimmed = re.sub(r"(pr|media|hq|inc|group|news|mag)$", "", site_key)
    nk = re.sub(r"[^a-z0-9]", "", name.lower())
    if len(nk) < 4:
        return False
    keys = {site_key, dotless, re.sub(r"[^a-z0-9]", "", site_domain)} | ({trimmed} if len(trimmed) >= 5 else set())
    return any(k and (k in nk or nk in k) for k in keys)


def check_page(html: str, how: str, brand: str, client_host: str, named_brands: set[str], site_domain: str) -> dict:
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
        if is_site_itself(name, site_domain):
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
