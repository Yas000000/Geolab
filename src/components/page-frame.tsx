"use client";

import { usePathname } from "next/navigation";

// Pages whose tables need more room than the standard 72rem column: GEO
// Rankings' Prompt Rankings has 13 number columns beside its Prompt column,
// and at 72rem the last ones only showed after scrolling sideways.
const WIDE_PAGES = /^\/clients\/[^/]+\/rankings(\/|$)/;

/**
 * The centered column a page's content sits in: 72rem, or 96rem on the wide
 * pages. The account bar, the client header and the client page body all use
 * it, so their edges stay lined up when a page goes wide.
 */
export function PageFrame({ className, children }: { className: string; children: React.ReactNode }) {
  const wide = WIDE_PAGES.test(usePathname() ?? "");
  return <div className={`mx-auto ${wide ? "max-w-[96rem]" : "max-w-6xl"} ${className}`}>{children}</div>;
}
