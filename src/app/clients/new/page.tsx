"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SearchableSelect, type SearchableSelectOption } from "@/components/searchable-select";
import { dedupePrompts, parsePromptsText, promptKey } from "@/lib/parse-prompts";
import { SCHEDULE_OPTIONS, type ScheduleValue } from "@/lib/schedule-options";
import { EXACT_MATCH_HINT, OTHER_NAMES_HINT } from "@/lib/client-names";

// A place the client is tracked in; Live Search asks each prompt once per location it's ticked for.
interface LocationDraft {
  country: string;
  city: string;
  label: string;
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
const locationName = (l: LocationDraft) => {
  const code = l.country.trim().toUpperCase();
  return l.label.trim() || [l.city.trim(), /^[A-Z]{2}$/.test(code) ? countryName(code) : code].filter(Boolean).join(", ");
};

const PLATFORM_OPTIONS = [
  { key: "openai", label: "ChatGPT", disabled: false },
  { key: "claude", label: "Claude", disabled: false },
  { key: "gemini", label: "Gemini", disabled: false },
  // A new client's first run is a Training Search, and Perplexity always
  // searches the web, so it only runs in Live Search (Run Now's Live Search
  // button includes it automatically). Shown disabled so it's clear why.
  { key: "perplexity", label: "Perplexity", disabled: true },
];

const PROMPTS_PLACEHOLDER = `## Best / Top
best widget consulting firms for enterprise clients
top rated widget repair services near Dallas

## Who Offers
who offers widget consulting for manufacturers`;

export default function NewClientPage() {
  const router = useRouter();
  const [brandName, setBrandName] = useState("");
  const [domain, setDomain] = useState("");
  const [otherNames, setOtherNames] = useState("");
  const [exactNameMatch, setExactNameMatch] = useState(false);
  const [promptsText, setPromptsText] = useState("");
  const [schedule, setSchedule] = useState<ScheduleValue>("MANUAL");
  const [ga4PropertyId, setGa4PropertyId] = useState("");
  const [gscSiteUrl, setGscSiteUrl] = useState("");
  const [platforms, setPlatforms] = useState<string[]>(["openai", "claude", "gemini"]);
  const [locations, setLocations] = useState<LocationDraft[]>([]);
  // Unticked locations per prompt (by promptKey); everything else is tracked everywhere.
  const [unticked, setUnticked] = useState<Record<string, number[]>>({});
  const parsed = useMemo(() => dedupePrompts(parsePromptsText(promptsText)).prompts, [promptsText]);
  const validLocations = locations.filter((l) => /^[A-Z]{2}$/.test(l.country.trim().toUpperCase()));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Populated from the connected Google account's own real properties/sites
  // (src/app/api/google/properties/route.ts) so GA4 Property ID / GSC Site
  // URL can be picked from a searchable list instead of manually copied out
  // of GA4's Admin UI -- falls back to the plain text inputs below when not
  // connected or the listing call fails, never blocks the form.
  const [googleConnected, setGoogleConnected] = useState(false);
  const [ga4Options, setGa4Options] = useState<SearchableSelectOption[]>([]);
  const [gscOptions, setGscOptions] = useState<SearchableSelectOption[]>([]);

  useEffect(() => {
    fetch("/api/google/properties")
      .then((res) => res.json())
      .then((data: { connected: boolean; ga4: { propertyId: string; displayName: string; accountDisplayName: string }[]; gsc: { siteUrl: string; permissionLevel: string }[] }) => {
        setGoogleConnected(data.connected);
        setGa4Options(
          data.ga4.map((p) => ({ value: p.propertyId, label: p.displayName, sublabel: p.accountDisplayName })),
        );
        setGscOptions(data.gsc.map((s) => ({ value: s.siteUrl, label: s.siteUrl, sublabel: s.permissionLevel })));
      })
      .catch(() => setGoogleConnected(false));
  }, []);

  function togglePlatform(key: string) {
    setPlatforms((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandName,
          domain,
          otherNames,
          exactNameMatch,
          promptsText,
          schedule,
          ga4PropertyId: ga4PropertyId || undefined,
          gscSiteUrl: gscSiteUrl || undefined,
          platforms,
          locations: validLocations.map((l) => ({ country: l.country.trim().toUpperCase(), city: l.city || null, label: l.label || undefined })),
          promptLocations: Object.fromEntries(
            parsed.map((p) => [
              promptKey(p.text),
              validLocations.map((_, i) => i).filter((i) => !(unticked[promptKey(p.text)] ?? []).includes(i)),
            ]),
          ),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== "COMPLETE") {
        setError(data.error ?? "The run failed. Check Vercel logs for details.");
        setSubmitting(false);
        return;
      }
      router.push(`/runs/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 md:py-10">
        <Link
          href="/clients"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          ← All clients
        </Link>

        <header className="mt-1 mb-8">
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Add Client</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Runs the prompts once immediately and gathers competitor data automatically.
            Schedule and analytics account are saved for a future automation pass — they
            don&apos;t trigger recurring runs yet.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Brand Name" required>
              <input
                type="text"
                required
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                className={inputClass}
                placeholder="Acme Corp"
              />
            </Field>
            <Field label="Domain" required>
              <input
                type="text"
                required
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                className={inputClass}
                placeholder="acmecorp.com"
              />
            </Field>
          </div>

          <Field label="Other Names">
            <input
              type="text"
              value={otherNames}
              onChange={(e) => setOtherNames(e.target.value)}
              className={inputClass}
              placeholder="Acme"
            />
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{OTHER_NAMES_HINT}</p>
            <label className="mt-3 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={exactNameMatch}
                onChange={(e) => setExactNameMatch(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
              />
              Match the name exactly
            </label>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{EXACT_MATCH_HINT}</p>
          </Field>

          <Field
            label="Prompts to Track"
            required
            hint="One prompt per line. Use ## Category Name to group prompts into sections; # for comments."
          >
            <textarea
              required
              rows={10}
              value={promptsText}
              onChange={(e) => setPromptsText(e.target.value)}
              className={`${inputClass} font-mono text-sm`}
              placeholder={PROMPTS_PLACEHOLDER}
            />
          </Field>

          <Field
            label="Locations"
            hint="Optional. Live Search asks each prompt once per location below, as if searching from there. Leave empty to search wherever the AI platforms default to."
          >
            <div className="space-y-2">
              {locations.map((l, i) => (
                <div key={i} className="grid grid-cols-[6rem_1fr_1fr_auto] gap-2">
                  <input
                    value={l.country}
                    maxLength={2}
                    placeholder="CA"
                    onChange={(e) => setLocations(locations.map((x, j) => (j === i ? { ...x, country: e.target.value } : x)))}
                    className={`${inputClass} uppercase`}
                    aria-label="Country code"
                  />
                  <input
                    value={l.city}
                    placeholder="City (optional)"
                    onChange={(e) => setLocations(locations.map((x, j) => (j === i ? { ...x, city: e.target.value } : x)))}
                    className={inputClass}
                    aria-label="City"
                  />
                  <input
                    value={l.label}
                    placeholder={locationName(l) || "Name"}
                    onChange={(e) => setLocations(locations.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    className={inputClass}
                    aria-label="Name"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setLocations(locations.filter((_, j) => j !== i));
                      setUnticked({});
                    }}
                    className="rounded-md border border-zinc-300 px-3 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setLocations([...locations, { country: "", city: "", label: "" }])}
                className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                + Add location
              </button>
            </div>
          </Field>

          {validLocations.length > 0 && parsed.length > 0 && (
            <Field label="Track each prompt in" hint="Every prompt is tracked in every location unless unticked here.">
              <div className="max-h-96 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-3 py-2 font-medium">Prompt</th>
                      {validLocations.map((l, i) => (
                        <th key={i} className="px-3 py-2 text-center font-medium whitespace-nowrap normal-case">
                          {locationName(l)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    {parsed.map((p) => {
                      const key = promptKey(p.text);
                      const off = unticked[key] ?? [];
                      return (
                        <tr key={key}>
                          <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{p.text}</td>
                          {validLocations.map((l, i) => (
                            <td key={i} className="px-3 py-1.5 text-center">
                              <input
                                type="checkbox"
                                checked={!off.includes(i)}
                                onChange={() =>
                                  setUnticked({ ...unticked, [key]: off.includes(i) ? off.filter((x) => x !== i) : [...off, i] })
                                }
                                aria-label={`${p.text}: ${locationName(l)}`}
                                className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
                              />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Field>
          )}

          <div className="grid grid-cols-3 gap-4">
            <Field label="Schedule">
              <select
                value={schedule}
                onChange={(e) => setSchedule(e.target.value as typeof schedule)}
                className={inputClass}
              >
                {SCHEDULE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="GA4 Property ID">
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
                  placeholder="Optional"
                />
              )}
            </Field>
            <Field label="GSC Site URL">
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
                  placeholder="Optional"
                />
              )}
            </Field>
          </div>

          <Field label="Platforms">
            <div className="flex flex-wrap gap-4">
              {PLATFORM_OPTIONS.map((p) => (
                <label
                  key={p.key}
                  className={`flex items-center gap-2 text-sm ${
                    p.disabled
                      ? "cursor-not-allowed text-zinc-400 dark:text-zinc-600"
                      : "text-zinc-700 dark:text-zinc-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={platforms.includes(p.key)}
                    disabled={p.disabled}
                    onChange={() => togglePlatform(p.key)}
                    className="h-4 w-4 rounded border-zinc-300 disabled:cursor-not-allowed dark:border-zinc-700"
                  />
                  {p.label}
                  {p.disabled && <span className="text-xs">(Live Search only)</span>}
                </label>
              ))}
            </div>
          </Field>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              {error}
            </div>
          )}

          {submitting && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300">
              Running the prompts across {platforms.length || 0} platform
              {platforms.length === 1 ? "" : "s"}… this usually takes 1-3 minutes.
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || platforms.length === 0}
            className="inline-flex items-center rounded-full bg-zinc-950 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            {submitting ? "Running…" : "Add Client & Run"}
          </button>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600";

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}
