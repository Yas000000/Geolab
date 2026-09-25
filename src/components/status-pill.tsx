const STYLES: Record<string, string> = {
  COMPLETE: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  RUNNING: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  PENDING: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        STYLES[status] ?? STYLES.PENDING
      }`}
    >
      {status}
    </span>
  );
}
