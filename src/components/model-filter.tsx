"use client";

import { useSearchParams, usePathname } from "next/navigation";

export function ModelFilter({ platforms }: { platforms: { key: string; label: string }[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("model") ?? "";

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("model", value);
    else params.delete("model");
    const qs = params.toString();
    // Full navigation, not router.push -- router.push has been observed to
    // silently fail to commit on this route (the RSC fetch starts, then gets
    // aborted with "destination stream closed early" and the URL reverts) --
    // see the same fix + explanation in date-range-picker.tsx.
    window.location.href = qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <select
      value={current}
      onChange={(e) => handleChange(e.target.value)}
      className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
    >
      <option value="">All Models</option>
      {platforms.map((p) => (
        <option key={p.key} value={p.key}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
