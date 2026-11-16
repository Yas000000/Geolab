import { timingSafeEqual } from "node:crypto";

/**
 * Calls the portal makes to itself, with no browser and so no login: the Python functions
 * (/api/run_pipeline, /api/outreach, /api/crawl_check) and the next step of an outreach
 * build. They carry this header, holding CRON_SECRET (already set on Vercel for the cron
 * routes), and the receiving end checks it. The Python side does the same check in
 * python_pipeline/internal_key.py.
 */
export const INTERNAL_KEY_HEADER = "x-internal-key";

export function internalHeaders(): Record<string, string> {
  const key = process.env.CRON_SECRET;
  return key ? { [INTERNAL_KEY_HEADER]: key } : {};
}

export function isInternalCall(request: Request): boolean {
  const key = process.env.CRON_SECRET;
  // Local dev without the secret: allowed. On Vercel the secret must be set and match.
  if (!key) return !process.env.VERCEL;
  const got = Buffer.from(request.headers.get(INTERNAL_KEY_HEADER) ?? "");
  const want = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}
