"use client";

import { useState } from "react";
import { EXACT_MATCH_HINT, OTHER_NAMES_HINT } from "@/lib/client-names";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600";

/** Settings > Other Names: Client.otherNames and exactNameMatch, saved on their own (PATCH /api/clients/[id]). */
export function OtherNamesForm({
  clientId,
  initialNames,
  initialExact,
}: {
  clientId: string;
  initialNames: string[];
  initialExact: boolean;
}) {
  const [text, setText] = useState(initialNames.join(", "));
  const [exact, setExact] = useState(initialExact);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otherNames: text, exactNameMatch: exact }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save.");
      } else {
        setText((data.client?.otherNames ?? []).join(", "));
        setSaved(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }

  return (
    <div className="space-y-3">
      <div>
        <input
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
          className={inputClass}
          placeholder="None"
          aria-label="Other names"
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {OTHER_NAMES_HINT}
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={exact}
            onChange={(e) => {
              setExact(e.target.checked);
              setSaved(false);
            }}
            className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
          />
          Match the name exactly
        </label>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {EXACT_MATCH_HINT} Changes here count from the next run on; earlier runs keep their numbers.
        </p>
      </div>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Saved</span>}
      </div>
    </div>
  );
}
