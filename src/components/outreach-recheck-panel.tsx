"use client";

import { useState } from "react";

const HELPER = "http://127.0.0.1:8790";

type Phase = "idle" | "missing" | "checking" | "saving";

/**
 * "Re-check blocked pages" on the Outreach Plan tab. The pages the server couldn't load go to
 * the Outreach Helper running on this PC (helper/outreach_helper.py), which opens them in real
 * Chrome and returns the listing checks; this posts them to the portal, which recomputes the
 * plan with no paid calls. Nothing here costs money.
 */
export function OutreachRecheckPanel({
  clientId,
  brand,
  clientHost,
  namedBrands,
  pages,
  lastRecheck,
}: {
  clientId: string;
  brand: string;
  clientHost: string;
  namedBrands: string[];
  pages: { site: string; url: string }[];
  lastRecheck: string | null;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ done: 0, total: pages.length });
  const [error, setError] = useState<string | null>(null);

  // Chrome asks once whether this site may reach apps on this device; the helper is one.
  const local = (path: string, init?: RequestInit) =>
    fetch(`${HELPER}${path}`, { ...init, targetAddressSpace: "loopback" } as RequestInit);

  async function run() {
    setError(null);
    try {
      const health = await local("/health");
      if (!health.ok) throw new Error();
    } catch {
      setPhase("missing");
      return;
    }
    setPhase("checking");
    setProgress({ done: 0, total: pages.length });
    const timer = setInterval(async () => {
      try {
        const p = (await (await local("/progress")).json()) as { done: number; total: number };
        setProgress({ done: p.done, total: p.total || pages.length });
      } catch {
        // the helper is busy with Chrome; the next poll catches up
      }
    }, 2000);
    try {
      const res = await local("/recheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, client_host: clientHost, named_brands: namedBrands, pages }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `The helper returned ${res.status}.`);
      clearInterval(timer);
      setPhase("saving");
      const saved = await fetch(`/api/clients/${clientId}/outreach/recheck`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checks: data.checks }),
      });
      const result = await saved.json().catch(() => ({}));
      if (!saved.ok) throw new Error(result.detail ? `${result.error} ${result.detail}` : (result.error ?? "Saving failed."));
      window.location.reload();
    } catch (err) {
      clearInterval(timer);
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  }

  const busy = phase === "checking" || phase === "saving";
  return (
    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        {pages.length} cited page{pages.length !== 1 ? "s" : ""} couldn&apos;t be read from the portal&apos;s server,
        because those sites block automated visits. Re-check them in Chrome on this PC with the Outreach Helper. It&apos;s
        free and updates the plan.
        {lastRecheck ? ` Last re-checked ${lastRecheck}.` : ""}
      </p>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="inline-flex items-center rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
      >
        {phase === "checking"
          ? `Re-checking in Chrome: ${progress.done} of ${progress.total}`
          : phase === "saving"
            ? "Saving the results…"
            : `Re-check ${pages.length} blocked page${pages.length !== 1 ? "s" : ""}`}
      </button>
      {phase === "checking" && (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Chrome opens the pages in a window parked off-screen; keep this tab and the helper window open until it
          finishes (about 5 to 10 seconds a page).
        </p>
      )}
      {phase === "missing" && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          The Outreach Helper isn&apos;t running on this PC. Start it by double-clicking{" "}
          <strong>Start Outreach Helper.cmd</strong> in the portal&apos;s <code>helper</code> folder
          (Documents\geo-reporting-portal\helper), then click the button again. If Chrome asks whether this site may
          reach apps on your device, allow it.
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
