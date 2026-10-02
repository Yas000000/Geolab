import { prisma } from "@/lib/prisma";
import { GOOGLE_CONNECTION_ID } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default async function SettingsPage() {
  const connection = await prisma.googleOAuthConnection.findUnique({ where: { id: GOOGLE_CONNECTION_ID } });

  const stale = connection?.lastVerifiedAt
    ? Date.now() - connection.lastVerifiedAt.getTime() > 6 * 24 * 60 * 60 * 1000
    : false;
  const needsReconnect = !connection || !!connection.lastError || stale;

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Settings</h1>

        <div className="mt-6 rounded-lg border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Google Analytics &amp; Search Console
          </div>

          {connection ? (
            <div className="mt-2 space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
              <div>
                Connected as{" "}
                <span className="font-medium text-zinc-950 dark:text-zinc-50">{connection.connectedEmail}</span>
              </div>
              <div className="text-zinc-500 dark:text-zinc-400">
                Last verified: {connection.lastVerifiedAt ? relativeTime(connection.lastVerifiedAt) : "never"}
              </div>
              {connection.lastError && (
                <div className="text-red-600 dark:text-red-400">Last error: {connection.lastError}</div>
              )}
              {needsReconnect && (
                <div className="font-medium text-red-600 dark:text-red-400">
                  Reconnect needed — Testing-mode refresh tokens expire roughly weekly.
                </div>
              )}
            </div>
          ) : (
            <div className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Not connected yet.</div>
          )}

          <a
            href="/api/auth/google/start"
            className="mt-4 inline-block rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            {connection ? "Reconnect Google Account" : "Connect Google Account"}
          </a>
        </div>
      </div>
    </div>
  );
}
