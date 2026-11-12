"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

const NAV_ITEMS = [
  { segment: "traffic", label: "GEO Traffic" },
  { segment: "rankings", label: "GEO Rankings" },
  { segment: "citations", label: "Citations" },
  { segment: "competitors", label: "Competitors" },
  { segment: "reports", label: "Reports" },
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

  // On phones the nav is a horizontally scrolling tab row; tabs past the edge
  // (e.g. Settings) would otherwise load scrolled out of view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
  }, [pathname]);

  return (
    <nav
      ref={navRef}
      aria-label="Client sections"
      className="relative -mx-4 flex gap-1 overflow-x-auto px-4 sm:-mx-6 sm:px-6 md:mx-0 md:block md:w-44 md:shrink-0 md:space-y-1 md:overflow-visible md:px-0"
    >
      {NAV_ITEMS.map((item) => {
        const href = `/clients/${clientId}/${item.segment}${qs ? `?${qs}` : ""}`;
        const active = pathname === `/clients/${clientId}/${item.segment}` || pathname.startsWith(`/clients/${clientId}/${item.segment}/`);
        return (
          <Link
            key={item.segment}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`block shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium ${
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
