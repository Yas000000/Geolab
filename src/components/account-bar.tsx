import Link from "next/link";
import { getViewer } from "@/lib/viewer";
import { LogoutButton } from "@/components/auth-forms";
import { PAGE_WIDTH } from "@/lib/page-width";

/** The slim bar across the top of every page once signed in (hidden when printing). */
export async function AccountBar() {
  const viewer = await getViewer();
  if (!viewer) return null;
  const link = "font-medium text-zinc-600 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100";

  return (
    <div className="border-b border-zinc-200 bg-zinc-100 px-4 py-1.5 text-xs sm:px-6 print:hidden dark:border-zinc-800 dark:bg-zinc-900">
      <div className={`mx-auto flex ${PAGE_WIDTH} flex-wrap items-center justify-end gap-x-4 gap-y-1`}>
        <span className="min-w-0 truncate text-zinc-500 dark:text-zinc-400">{viewer.email}</span>
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
        <LogoutButton />
      </div>
    </div>
  );
}
