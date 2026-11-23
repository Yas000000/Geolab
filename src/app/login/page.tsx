import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getViewer } from "@/lib/viewer";
import { homePath, safeNext } from "@/lib/auth";
import { LoginForm } from "@/components/auth-forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in · GEO Reporting Portal" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const viewer = await getViewer();
  if (viewer) redirect(homePath(viewer));
  const { next } = await searchParams;

  // Styled like the GEO proposal's cover (branding, 2026-11-23): the Interdependence red with
  // its wordmark (the logo file's background is the same red), the title on the proposal's
  // dark bar, then the sign-in card.
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-brand px-4 py-16">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/interdependence-logo.jpg" alt="Interdependence" width={1018} height={343} className="mb-2 w-72 max-w-full" />
      <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-lg dark:bg-zinc-950">
        <h1 className="bg-ink px-6 py-3 text-lg font-semibold text-white">GEO Reporting Portal</h1>
        <div className="px-6 pb-8 pt-5">
          <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">Sign in to continue.</p>
          <LoginForm next={safeNext(typeof next === "string" ? next : null)} />
        </div>
      </div>
    </div>
  );
}
