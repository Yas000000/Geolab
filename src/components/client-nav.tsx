"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const NAV_ITEMS = [
  { segment: "traffic", label: "GEO Traffic" },
  { segment: "rankings", label: "GEO Rankings" },
  { segment: "competitors", label: "Competitors" },
  { segment: "settings", label: "Settings" },
];

// Date-range state lives in the URL (see date-range-picker.tsx), scoped per
// page by Next.js default -- carry it across sidebar nav so picking a range
// on Rankings and switching to Traffic (or back) doesn't reset to All Time.
const CARRIED_PARAMS = ["start", "end", "preset", "n", "compare", "compareStart", "compareEnd"];

export function ClientNav({ clientId }: { clientId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const carried = new URLSearchParams();
  for (const key of CARRIED_PARAMS) {
    const value = searchParams.get(key);
    if (value) carried.set(key, value);
  }
  const qs = carried.toString();

  return (
    <nav className="w-44 shrink-0 space-y-1">
      {NAV_ITEMS.map((item) => {
        const href = `/clients/${clientId}/${item.segment}${qs ? `?${qs}` : ""}`;
        const active = pathname === `/clients/${clientId}/${item.segment}` || pathname.startsWith(`/clients/${clientId}/${item.segment}/`);
        return (
          <Link
            key={item.segment}
            href={href}
            className={`block rounded-md px-3 py-2 text-sm font-medium ${
              active
                ? "bg-zinc-950 text-white dark:bg-zinc-50 dark:text-zinc-950"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
