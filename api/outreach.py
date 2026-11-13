import traceback
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from python_pipeline.outreach import (
    build_plan,
    check_pages,
    domain_of,
    named_brands_from,
    research_site,
    site_stats,
)

app = FastAPI()

# Stateless, like run_pipeline and crawl_check: src/lib/outreach.ts sends the crawl's answers
# and the client's saved research, orchestrates a build and stores everything. Only the
# Outreach Plan tab's Build button leads here; nothing runs on a schedule. One path with an
# `action`, since Vercel routes only /api/outreach itself to this file.


class Cell(BaseModel):
    mentioned: bool
    rank: int | None = None
    full_response: str
    citations: list[dict]
    error: str | None = None


class Row(BaseModel):
    prompt: str
    category: str | None = None
    platforms: dict[str, Cell]


class OutreachRequest(BaseModel):
    action: Literal["sites", "check_pages", "research", "plan"]
    brand: str = ""
    client_domain: str
    # sites, plan
    rows: list[Row] = []
    platforms: list[str] = []
    target_domains: list[str] = []
    extracted: list[list[str]] = []
    # check_pages, plan
    named_brands: list[str] = []
    urls_by_site: dict[str, list[str]] = {}
    # research
    site: str = ""
    stats: dict = {}
    total_prompts: int = 0
    pages: dict[str, dict] = {}
    earlier: dict | None = None
    earlier_at: str | None = None
    # plan
    site_cache: dict[str, dict] = {}
    placed_cache: dict | None = None
    estimate_cache: dict = {}


@app.post("/api/outreach")
def outreach(p: OutreachRequest) -> dict:
    try:
        if p.action == "sites":
            # Per-site citation stats for the target sites, and the firm names to look for on their pages.
            rows = [r.model_dump() for r in p.rows]
            return {
                "stats": site_stats(rows, p.platforms, p.target_domains, domain_of(p.client_domain)),
                "named_brands": sorted(named_brands_from(p.extracted, rows)),
                "total_prompts": len({r["prompt"] for r in rows}),
            }
        if p.action == "check_pages":
            checks, cost = check_pages(p.urls_by_site, p.brand, domain_of(p.client_domain), set(p.named_brands))
            return {"checks": checks, "cost": cost}
        if p.action == "research":
            result, cost = research_site(p.brand, p.client_domain, p.site, p.stats, p.total_prompts, p.pages,
                                         p.earlier, p.earlier_at)
            return {"research": result, "cost": cost}
        return build_plan(p.brand, p.client_domain, [r.model_dump() for r in p.rows], p.platforms,
                          p.target_domains, set(p.named_brands), p.site_cache, p.placed_cache, p.estimate_cache)
    except Exception as e:  # the TS side stores the message on the failed build
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}\n{traceback.format_exc()[-1500:]}")
