"use client";

export function ClientSwitcher({
  clients,
  currentId,
}: {
  clients: { id: string; name: string }[];
  currentId: string;
}) {
  function handleChange(id: string) {
    if (!id || id === currentId) return;
    // Full navigation, not router.push -- router.push has been observed to
    // silently fail to commit on client dashboard routes (the RSC fetch
    // starts, then aborts with "destination stream closed early" and the
    // URL reverts). Same workaround as model-filter.tsx / date-range-picker.tsx.
    window.location.href = `/clients/${id}/traffic`;
  }

  return (
    <label className="flex items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Client
      </span>
      <select
        value={currentId}
        onChange={(e) => handleChange(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
      >
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
