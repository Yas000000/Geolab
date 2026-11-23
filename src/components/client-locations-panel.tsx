"use client";

import { useState } from "react";

export interface LocationRow {
  id: string;
  label: string;
  country: string;
  region: string | null;
  city: string | null;
  answers: number; // answers searched from here (a location with answers can't be removed)
}

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600";
const buttonClass =
  "inline-flex items-center rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900";

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Settings > Locations: the places a client is tracked in (MacuMira: Canada,
 * Australia, New Zealand). Live Search asks each prompt once per location it's
 * ticked for in Tracked Prompts, as if searching from there.
 */
export function ClientLocationsPanel({ clientId, locations }: { clientId: string; locations: LocationRow[] }) {
  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [label, setLabel] = useState("");
  const [trackAll, setTrackAll] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  const code = country.trim().toUpperCase();
  const validCode = /^[A-Z]{2}$/.test(code);
  const suggested = [city.trim(), validCode ? countryName(code) : ""].filter(Boolean).join(", ");

  async function send(url: string, method: string, body?: object) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        setBusy(false);
        return;
      }
      // Tracked Prompts and the tabs read locations on the server: reload to show the change.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Live Search asks each prompt once for every location it&apos;s ticked for in Tracked Prompts, as if searching from
        there, so each location costs about as much as another full Live Search. Training Search answers from the AI&apos;s
        memory and ignores locations. Every tab can show one location or all of them side by side.
      </p>

      {locations.length > 0 ? (
        <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
          {locations.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              {editing === l.id ? (
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} className={`${inputClass} max-w-xs`} />
                  <button
                    type="button"
                    disabled={busy || !editLabel.trim()}
                    onClick={() => send(`/api/clients/${clientId}/locations/${l.id}`, "PATCH", { label: editLabel })}
                    className={buttonClass}
                  >
                    Save
                  </button>
                  <button type="button" onClick={() => setEditing(null)} className={buttonClass}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span>
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{l.label}</span>
                    <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                      {[l.city, l.region, `${countryName(l.country)} (${l.country})`].filter(Boolean).join(", ")}
                      {" · "}
                      {l.answers} {l.answers === 1 ? "answer" : "answers"}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(l.id);
                        setEditLabel(l.label);
                      }}
                      className={buttonClass}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      disabled={busy || l.answers > 0}
                      title={l.answers > 0 ? "It has answers, so it stays. Untick it on prompts to stop tracking there." : undefined}
                      onClick={() => {
                        if (window.confirm(`Remove ${l.label}? It comes off every prompt too.`)) {
                          send(`/api/clients/${clientId}/locations/${l.id}`, "DELETE");
                        }
                      }}
                      className={buttonClass}
                    >
                      Remove
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No locations: Live Search asks each prompt once, wherever the AI platforms default to.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">Country code</label>
          <input
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            maxLength={2}
            placeholder="CA"
            className={`${inputClass} uppercase`}
          />
          <p className="mt-1 h-4 text-xs text-zinc-500 dark:text-zinc-400">{validCode ? countryName(code) : "Two letters, e.g. CA, AU, NZ"}</p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">City (optional)</label>
          <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Vancouver" className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">Region (optional)</label>
          <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="British Columbia" className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">Name</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={suggested || "Canada"} className={inputClass} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={trackAll} onChange={(e) => setTrackAll(e.target.checked)} className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700" />
          Track every prompt here
        </label>
        <button
          type="button"
          disabled={busy || !validCode}
          onClick={() =>
            send(`/api/clients/${clientId}/locations`, "POST", {
              country: code,
              city: city || null,
              region: region || null,
              label: label || undefined,
              trackAllPrompts: trackAll,
            })
          }
          className="inline-flex items-center rounded-full bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Add location"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
