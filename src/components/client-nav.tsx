"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { segment: "traffic", label: "GEO Traffic" },
  { segment: "rankings", label: "GEO Rankings" },
  { segment: "competitors", label: "Competitors" },
  { segment: "settings", label: "Settings" },
];

export function ClientNav({ clientId }: { clientId: string }) {
  const pathname = usePathname();

  return (
    <nav className="w-44 shrink-0 space-y-1">
      {NAV_ITEMS.map((item) => {
        const href = `/clients/${clientId}/${item.segment}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
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
