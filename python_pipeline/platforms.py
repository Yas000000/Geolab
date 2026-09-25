"""
AI platform clients. Each returns a plain string response for a given prompt.

Ported from geo-rank-checker/platforms.py with one deliberate, flagged
deviation from "port verbatim": the 3 query functions are converted from
synchronous to `async def`, using each provider's async SDK client, so the
orchestration layer can run many of these concurrently instead of the
source's fully-sequential loop (25 prompts x 3 platforms = 75 blocking calls
in the CLI today -- would badly exceed a serverless function's time limit).
Model IDs, the shared system prompt, and each function's exact retry policy
are preserved unchanged -- this is a concurrency-only change, not an
algorithm change.
"""

import asyncio
import os
from dataclasses import dataclass


@dataclass
class PlatformResult:
    platform: str
    response: str
    error: str | None = None


_SYSTEM_PROMPT = (
    "You are a helpful assistant. When listing brands, companies, products, services, or providers, "
    "always use a numbered list (1., 2., 3., etc.). Keep each list item concise — brand or company "
    "name first, then a brief description if needed."
)


async def query_openai(prompt: str) -> PlatformResult:
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
        resp = await client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            max_tokens=1024,
        )
        return PlatformResult("ChatGPT (GPT-4o)", resp.choices[0].message.content or "")
    except Exception as e:
        return PlatformResult("ChatGPT (GPT-4o)", "", error=str(e))


async def query_claude(prompt: str) -> PlatformResult:
    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        resp = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        return PlatformResult("Claude (Sonnet 4.6)", resp.content[0].text)
    except Exception as e:
        return PlatformResult("Claude (Sonnet 4.6)", "", error=str(e))


async def query_gemini(prompt: str) -> PlatformResult:
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    last_err = ""
    for attempt in range(3):
        try:
            resp = await client.aio.models.generate_content(
                model="gemini-flash-lite-latest",
                contents=prompt,
                config=types.GenerateContentConfig(system_instruction=_SYSTEM_PROMPT),
            )
            return PlatformResult("Gemini (Flash Lite)", resp.text)
        except Exception as e:
            last_err = str(e)
            # Retry on transient server overload; bail immediately on quota/auth errors
            if "503" in last_err or "UNAVAILABLE" in last_err:
                await asyncio.sleep(5 * (attempt + 1))
            else:
                break
    return PlatformResult("Gemini (Flash Lite)", "", error=last_err)


# Registry — add perplexity here when key is available
PLATFORMS = {
    "openai": query_openai,
    "claude": query_claude,
    "gemini": query_gemini,
}
