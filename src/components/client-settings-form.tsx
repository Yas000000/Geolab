"use client";

import { useEffect, useState } from "react";
import { SearchableSelect, type SearchableSelectOption } from "@/components/searchable-select";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600";

export function ClientSettingsForm({
  clientId,
  initialSchedule,
  initialGa4PropertyId,
  initialGscSiteUrl,
}: {
  clientId: string;
  initialSchedule: "MANUAL" | "NIGHTLY" | "WEEKLY" | "MONTHLY";
  initialGa4PropertyId: string;
  initialGscSiteUrl: string;
}) {
  const [schedule, setSchedule] = useState(initialSchedule);
  const [ga4PropertyId, setGa4PropertyId] = useState(initialGa4PropertyId);
  const [gscSiteUrl, setGscSiteUrl] = useState(initialGscSiteUrl);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same pattern as clients/new/page.tsx -- lets the GA4/GSC fields be
  // picked from the connected Google account's real properties/sites
  // instead of pasted in manually. Falls back to plain text inputs when
  // not connected or the listing call fails.
  const [googleConnected, setGoogleConnected] = useState(false);
  const [ga4Options, setGa4Options] = useState<SearchableSelectOption[]>([]);
  const [gscOptions, setGscOptions] = useState<SearchableSelectOption[]>([]);

  useEffect(() => {
    fetch("/api/google/properties")
      .then((res) => res.json())
      .then(
        (data: {
          connected: boolean;
          ga4: { propertyId: string; displayName: string; accountDisplayName: string }[];
          gsc: { siteUrl: string; permissionLevel: string }[];
        }) => {
          setGoogleConnected(data.connected);
          setGa4Options(
            data.ga4.map((p) => ({ value: p.propertyId, label: p.displayName, sublabel: p.accountDisplayName })),
          );
          setGscOptions(data.gsc.map((s) => ({ value: s.siteUrl, label: s.siteUrl, sublabel: s.permissionLevel })));
        },
      )
      .catch(() => setGoogleConnected(false));
  }, []);

  async function handleSave() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule, ga4PropertyId: ga4PropertyId || null, gscSiteUrl: gscSiteUrl || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save.");
        setSaving(false);
        return;
      }
      setSaving(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Schedule</label>
          <select value={schedule} onChange={(e) => setSchedule(e.target.value as typeof schedule)} className={inputClass}>
            <option value="MANUAL">Manual</option>
            <option value="NIGHTLY">Nightly</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">GA4 Property ID</label>
          {googleConnected && ga4Options.length > 0 ? (
            <SearchableSelect
              options={ga4Options}
              value={ga4PropertyId}
              onChange={setGa4PropertyId}
              placeholder="Search properties…"
              className={inputClass}
            />
          ) : (
            <input
              type="text"
              value={ga4PropertyId}
              onChange={(e) => setGa4PropertyId(e.target.value)}
              className={inputClass}
              placeholder="Not set"
            />
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">GSC Site URL</label>
          {googleConnected && gscOptions.length > 0 ? (
            <SearchableSelect
              options={gscOptions}
              value={gscSiteUrl}
              onChange={setGscSiteUrl}
              placeholder="Search sites…"
              className={inputClass}
            />
          ) : (
            <input
              type="text"
              value={gscSiteUrl}
              onChange={(e) => setGscSiteUrl(e.target.value)}
              className={inputClass}
              placeholder="Not set"
            />
          )}
        </div>
      </div>

      {!googleConnected && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          No Google account connected — connect one in the top-level{" "}
          <a href="/settings" className="underline">
            Settings
          </a>{" "}
          page to pick properties/sites from a list instead of pasting IDs.
        </p>
      )}

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
