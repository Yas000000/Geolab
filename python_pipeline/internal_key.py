"""Only the portal itself may call the Python functions (/api/run_pipeline, /api/outreach,
/api/crawl_check): every request must carry the internal key header, holding CRON_SECRET.
The Node side sends it from src/lib/internal-key.ts. Without this, anyone who knew the URL
could run paid AI calls.
"""

import hmac
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

HEADER = "x-internal-key"


def require_internal_key(app: FastAPI) -> None:
    @app.middleware("http")
    async def _check(request: Request, call_next):
        key = os.environ.get("CRON_SECRET", "")
        if not key:
            # Local dev without the secret is allowed; on Vercel the secret must be set.
            if os.environ.get("VERCEL"):
                return JSONResponse({"error": "Not allowed."}, status_code=403)
            return await call_next(request)
        got = request.headers.get(HEADER, "")
        if not hmac.compare_digest(got.encode(), key.encode()):
            return JSONResponse({"error": "Not allowed."}, status_code=403)
        return await call_next(request)
