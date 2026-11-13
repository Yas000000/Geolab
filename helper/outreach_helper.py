"""
Outreach Helper: re-checks blocked pages for the portal's Outreach Plan tab in real Chrome on
this PC.

Some sites (Clutch, Psychology Today...) refuse the portal's server, so a build can't tell
whether the client is listed on those cited pages. Real Chrome in a normal window gets past
their bot checks. This helper runs on the PC where you view the portal: the tab's "Re-check
blocked pages" button sends it the pages, it opens each one in Chrome (window parked
off-screen), reads it with the same listing check the server uses
(python_pipeline/page_check.py) and hands the results back to the tab, which saves them.
No AI calls, no cost.

Start it with "Start Outreach Helper.cmd" (or: python helper/outreach_helper.py) and leave the
window open while you re-check. Needs Python with playwright and beautifulsoup4, and Google
Chrome installed.

Listens on 127.0.0.1 only, and only answers the portal's own pages (production and local dev),
so other websites open in your browser can't use it.
"""

import asyncio
import json
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from python_pipeline.page_check import check_page, looks_blocked  # noqa: E402

PORT = 8790
VERSION = 1
ALLOWED_ORIGINS = re.compile(r"^(https://geo-reporting-portal\.vercel\.app|http://(localhost|127\.0\.0\.1)(:\d+)?)$")
# Pages open three at a time in one Chrome window, so a bot check cleared on one page of a
# site stays cleared for its other pages.
TABS = 3
WAIT_FOR_BOT_CHECK_S = 20
# A site that blocks Chrome on its first few pages and loads none blocks this PC too; its other
# pages are skipped rather than each waiting out the bot check (Psychology Today: 100+ pages).
BLOCKS_BEFORE_SKIP = 3

_job_lock = threading.Lock()
progress = {"running": False, "done": 0, "total": 0, "site": ""}


async def _check_all(pages: list[dict], brand: str, client_host: str, named: set[str]) -> dict:
    from playwright.async_api import async_playwright

    checks: dict[str, dict[str, dict]] = {}
    gate = asyncio.Semaphore(TABS)
    tally: dict[str, list[int]] = {}   # site -> [pages blocked, pages loaded]
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            channel="chrome", headless=False,
            args=["--window-position=-32000,-32000", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context()

        async def one(page_info):
            site, url = page_info["site"], page_info["url"]
            async with gate:
                progress["site"] = site
                blocked, loaded = tally.setdefault(site, [0, 0])
                if blocked >= BLOCKS_BEFORE_SKIP and not loaded:
                    checks.setdefault(site, {})[url] = {
                        "status": "unreachable", "fetched_with": "chrome",
                        "reason": "blocked in Chrome too (the site's other pages were skipped)",
                        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
                    progress["done"] += 1
                    return
                tab = await context.new_page()
                try:
                    await tab.goto(url, wait_until="domcontentloaded", timeout=30000)
                    await tab.wait_for_timeout(2500)
                    html, deadline = await _html(tab), time.monotonic() + WAIT_FOR_BOT_CHECK_S
                    while looks_blocked(html) and time.monotonic() < deadline:
                        await tab.wait_for_timeout(1500)
                        html = await _html(tab)
                    if looks_blocked(html):
                        check = {"status": "unreachable", "fetched_with": "chrome", "reason": "blocked in Chrome too"}
                    else:
                        check = check_page(html, "chrome", brand, client_host, named, site)
                except Exception as e:
                    check = {"status": "unreachable", "fetched_with": "chrome",
                             "reason": f"Chrome couldn't load it ({type(e).__name__})"}
                finally:
                    await tab.close()
                tally[site][1 if check["status"] == "checked" else 0] += 1
                check["checked_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                checks.setdefault(site, {})[url] = check
                progress["done"] += 1

        # Grouped by site so each site's pages share the bot check Chrome cleared first.
        await asyncio.gather(*(one(pg) for pg in sorted(pages, key=lambda x: x["site"])))
        await browser.close()
    return checks


async def _html(tab) -> str:
    try:
        return await tab.content()
    except Exception:   # mid-navigation, e.g. a bot check handing over to the real page
        return ""


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "")
        if ALLOWED_ORIGINS.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            # Chrome's local network access check for a public site calling this PC.
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

    def _json(self, status: int, body: dict):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self) -> bool:
        origin = self.headers.get("Origin")
        # No Origin: a tool on this PC (curl). A browser always sends one, and only the portal's pass.
        return origin is None or bool(ALLOWED_ORIGINS.match(origin))

    def do_OPTIONS(self):
        self.send_response(204 if self._allowed() else 403)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if not self._allowed():
            return self._json(403, {"error": "Only the GEO reporting portal can use this helper."})
        if self.path == "/health":
            return self._json(200, {"ok": True, "version": VERSION, "busy": progress["running"]})
        if self.path == "/progress":
            return self._json(200, progress)
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed():
            return self._json(403, {"error": "Only the GEO reporting portal can use this helper."})
        if self.path != "/recheck":
            return self._json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            pages = [p for p in body.get("pages", []) if isinstance(p, dict) and p.get("url") and p.get("site")]
            brand, client_host = str(body["brand"]), str(body["client_host"])
            named = {str(n) for n in body.get("named_brands", [])}
        except (ValueError, KeyError, TypeError):
            return self._json(400, {"error": "Expected {brand, client_host, named_brands, pages: [{site, url}]}."})
        if not _job_lock.acquire(blocking=False):
            return self._json(409, {"error": "A re-check is already running in the helper."})
        try:
            progress.update(running=True, done=0, total=len(pages), site="")
            print(f"Re-checking {len(pages)} pages for {brand} in Chrome...")
            started = time.monotonic()
            checks = asyncio.run(_check_all(pages, brand, client_host, named))
            loaded = sum(1 for site in checks.values() for c in site.values() if c["status"] == "checked")
            print(f"  done in {time.monotonic() - started:.0f}s: {loaded} of {len(pages)} pages loaded.")
            self._json(200, {"checks": checks, "version": VERSION})
        except Exception as e:
            print(f"  failed: {e}")
            self._json(500, {"error": f"The helper couldn't run Chrome: {e}. Is Google Chrome installed?"})
        finally:
            progress["running"] = False
            _job_lock.release()

    def log_message(self, *args):   # keep the window to the helper's own messages
        pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Outreach Helper is running on http://127.0.0.1:{PORT}")
    print("Leave this window open, then click \"Re-check blocked pages\" on the portal's Outreach Plan tab.")
    print("Close the window (or press Ctrl+C) when you're done.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
