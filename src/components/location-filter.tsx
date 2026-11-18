"use client";

import { useSearchParams, usePathname } from "next/navigation";

/**
 * The Location dropdown for clients tracked in several places (MacuMira:
 * Canada, Australia, New Zealand): "All locations" (the default) shows each
 * one side by side; picking one shows the page for that location alone. The
 * choice is the `location` URL param, which the tab links carry (client-nav.tsx).
 */
export function LocationFilter({ locations }: { locations: { key: string; label: string }[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("location") ?? "";

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("location", value);
    else params.delete("location");
    const qs = params.toString();
    // Full navigation, like ModelFilter: router.push has failed to commit on these routes.
    window.location.href = qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <select
      value={current}
      onChange={(e) => handleChange(e.target.value)}
      aria-label="Location"
      className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
    >
      <option value="">All locations</option>
      {locations.map((l) => (
        <option key={l.key} value={l.key}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
