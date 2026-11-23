import type { Metadata } from "next";
import { requireTeamPage } from "@/lib/viewer";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { ChangePasswordForm } from "@/components/auth-forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your account · GEO Reporting Portal" };

export default async function AccountPage() {
  const viewer = await requireTeamPage();

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 md:py-10">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Your account</h1>
        <p className="mb-6 mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Signed in as {viewer.name ? `${viewer.name} (${viewer.email})` : viewer.email}
        </p>
        {viewer.mustChangePassword && (
          <div className="mb-6 max-w-xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            You signed in with a password someone else generated. Choose your own to continue.
          </div>
        )}
        <section className="rounded-lg border border-zinc-200 bg-white px-4 py-5 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-brand-text dark:text-red-400">
            {viewer.mustChangePassword ? "Choose your password" : "Change password"}
          </h2>
          <ChangePasswordForm forced={viewer.mustChangePassword} minLength={MIN_PASSWORD_LENGTH} />
        </section>
      </div>
    </div>
  );
}
