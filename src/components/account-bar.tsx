import Link from "next/link";
import { getViewer } from "@/lib/viewer";
import { homePath } from "@/lib/auth";
import { LogoutButton } from "@/components/auth-forms";
import { PAGE_WIDTH } from "@/lib/page-width";

/**
 * The bar across the top of every page once signed in (hidden when printing): the
 * Interdependence red band with its wordmark, as on the GEO proposal's cover (branding,
 * 2026-11-23). The logo file's own background is this same red, so it sits on the band
 * seamlessly; its built-in margin gives the bar its height.
 */
export async function AccountBar() {
  const viewer = await getViewer();
  if (!viewer) return null;
  const link = "font-medium text-white/90 hover:text-white hover:underline";

  return (
    <div className="bg-brand px-4 text-xs sm:px-6 print:hidden">
      <div className={`mx-auto flex ${PAGE_WIDTH} flex-wrap items-center justify-between gap-x-4`}>
        <Link href={homePath(viewer)} className="-ml-3 shrink-0" aria-label="Interdependence: home">
          {/* eslint-disable-next-line @next/next/no-img-element -- a fixed local brand image, no resizing needed */}
          <img src="/brand/interdependence-logo.jpg" alt="Interdependence" width={143} height={48} className="h-12 w-auto" />
        </Link>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-4 gap-y-1 py-2">
          <span className="min-w-0 truncate text-white/80">{viewer.email}</span>
          {viewer.role === "TEAM" && !viewer.mustChangePassword && (
            <>
              <Link href="/clients" className={link}>
                Clients
              </Link>
              <Link href="/access" className={link}>
                Access
              </Link>
              <Link href="/account" className={link}>
                Account
              </Link>
            </>
          )}
          <LogoutButton className={`${link} disabled:opacity-50`} />
        </div>
      </div>
    </div>
  );
}
