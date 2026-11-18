"use client";

import { useMemo, useState } from "react";
import { dedupePrompts, formatPromptsText, parsePromptsText, promptKey, type ParsedPrompt } from "@/lib/parse-prompts";

// Live Search measured ~285s for 55 prompts (Yellowbrick, 2026-10-12);
// scaling linearly, the run routes' 800s maxDuration fits ~150. Warn at
// 120 to keep a margin, since that scaling is an estimate, not measured.
// With locations it's the questions asked that count: each prompt once per
// location it's tracked in.
const LIVE_SEARCH_SAFE_MAX = 120;

function parseAndDedupe(text: string) {
  return dedupePrompts(parsePromptsText(text));
}

function sameList(a: ParsedPrompt[], b: ParsedPrompt[]): boolean {
  return a.length === b.length && a.every((p, i) => p.text === b[i].text && p.category === b[i].category);
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function TrackedPromptsEditor({
  clientId,
  initialText,
  locations = [],
  initialLocations = {},
}: {
  clientId: string;
  initialText: string;
  locations?: { id: string; label: string }[]; // the client's locations (Settings > Locations)
  initialLocations?: Record<string, string[]>; // each tracked prompt's location ids, by promptKey
}) {
  const [savedText, setSavedText] = useState(initialText);
  const [text, setText] = useState(initialText);
  const [savedLocations, setSavedLocations] = useState(initialLocations);
  const [picked, setPicked] = useState(initialLocations);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saved = useMemo(() => parseAndDedupe(savedText).prompts, [savedText]);
  const { prompts: current, duplicates } = useMemo(() => parseAndDedupe(text), [text]);

  const savedKeys = useMemo(() => new Set(saved.map((p) => promptKey(p.text))), [saved]);
  const currentKeys = useMemo(() => new Set(current.map((p) => promptKey(p.text))), [current]);
  const added = current.filter((p) => !savedKeys.has(promptKey(p.text))).length;
  const removed = saved.filter((p) => !currentKeys.has(promptKey(p.text))).length;

  // A prompt's locations: as ticked, else (a new prompt) every location.
  const allIds = locations.map((l) => l.id);
  const locationsOf = (p: ParsedPrompt) => picked[promptKey(p.text)] ?? allIds;
  const locationsChanged = current.some((p) => {
    const key = promptKey(p.text);
    return savedKeys.has(key) && !sameIds(locationsOf(p), savedLocations[key] ?? []);
  });
  const dirty = !sameList(current, saved) || locationsChanged;
  const asks = current.reduce((n, p) => n + Math.max(1, locations.length ? locationsOf(p).length : 1), 0);

  function toggle(p: ParsedPrompt, id: string) {
    const key = promptKey(p.text);
    const now = locationsOf(p);
    setPicked({ ...picked, [key]: now.includes(id) ? now.filter((x) => x !== id) : [...now, id] });
    setMessage(null);
  }

  function setColumn(id: string, on: boolean) {
    const next = { ...picked };
    for (const p of current) {
      const now = locationsOf(p);
      next[promptKey(p.text)] = on ? [...new Set([...now, id])] : now.filter((x) => x !== id);
    }
    setPicked(next);
    setMessage(null);
  }

  async function handleSave() {
    setError(null);
    setMessage(null);
    setSaving(true);
    try {
      const locationsByKey = Object.fromEntries(current.map((p) => [promptKey(p.text), locationsOf(p)]));
      const res = await fetch(`/api/clients/${clientId}/prompts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, locations: locationsByKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save.");
        return;
      }
      const normalized = formatPromptsText(current);
      setSavedText(normalized);
      setText(normalized);
      setSavedLocations(locationsByKey);
      setPicked(locationsByKey);
      setMessage(
        data.unchanged
          ? "No changes to save."
          : `Saved ${data.count} prompts (${data.added} new, ${data.removed} removed). The next run will use this list.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        The prompts Run Now and scheduled runs check. Paste new prompts on their own lines, edit or delete existing
        ones, then save. Use <code>## Category Name</code> to start a section; lines below a heading belong to it.
      </p>

      <textarea
        rows={16}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setMessage(null);
        }}
        spellCheck={false}
        className="w-full resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600"
        placeholder={"## Best / Top\nbest widget consulting firms for enterprise clients\n\n## Who Offers\nwho offers widget consulting for manufacturers"}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{current.length} prompts</span>
        {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added} new</span>}
        {removed > 0 && <span className="text-red-600 dark:text-red-400">−{removed} removed</span>}
        {duplicates > 0 && (
          <span className="text-zinc-500 dark:text-zinc-400">
            {duplicates} duplicate{duplicates === 1 ? "" : "s"} will be skipped
          </span>
        )}
        {locations.length > 0 && <span>{asks} questions per platform in a Live Search</span>}
      </div>

      {/* Which locations each prompt is tracked in (Live Search asks it once per ticked location). */}
      {locations.length > 0 && current.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Prompt</th>
                {locations.map((l) => {
                  const all = current.every((p) => locationsOf(p).includes(l.id));
                  return (
                    <th key={l.id} className="px-3 py-2 text-center font-medium whitespace-nowrap">
                      <label className="inline-flex items-center gap-1.5 normal-case">
                        <input
                          type="checkbox"
                          checked={all}
                          onChange={(e) => setColumn(l.id, e.target.checked)}
                          title={`Tick or untick ${l.label} for every prompt`}
                          className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-700"
                        />
                        {l.label}
                      </label>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {current.map((p) => (
                <tr key={promptKey(p.text)}>
                  <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{p.text}</td>
                  {locations.map((l) => (
                    <td key={l.id} className="px-3 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={locationsOf(p).includes(l.id)}
                        onChange={() => toggle(p, l.id)}
                        aria-label={`${p.text}: ${l.label}`}
                        className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {asks > LIVE_SEARCH_SAFE_MAX && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          Live Search took about 285 seconds for 55 questions, and a run can last up to 800 seconds. Above about{" "}
          {LIVE_SEARCH_SAFE_MAX} questions per platform ({asks} now, counting each location), Live Search may time out.
          Training Search has more headroom.
        </div>
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
          disabled={saving || !dirty || current.length === 0}
          className="inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {saving ? "Saving…" : "Save prompts"}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            onClick={() => {
              setText(savedText);
              setPicked(savedLocations);
              setError(null);
            }}
            className="inline-flex items-center rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Discard changes
          </button>
        )}
        {message && <span className="text-sm text-emerald-600 dark:text-emerald-400">{message}</span>}
      </div>
    </div>
  );
}
