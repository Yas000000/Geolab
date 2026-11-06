from fastapi import FastAPI
from pydantic import BaseModel

from python_pipeline.crawlability import run_all_checks

app = FastAPI()


class CrawlCheckRequest(BaseModel):
    url: str
    brand: str | None = None


@app.post("/api/crawl_check")
async def crawl_check(payload: CrawlCheckRequest) -> dict:
    """Stateless, like run_pipeline: the TS side (src/lib/crawl-check.ts) stores the result.
    `url` in the reply is where the site's redirects landed, which is what was checked."""
    checked_url, results = await run_all_checks(payload.url, payload.brand)
    return {"url": checked_url, "results": results}
