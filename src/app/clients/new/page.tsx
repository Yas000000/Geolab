"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const PLATFORM_OPTIONS = [
  { key: "openai", label: "ChatGPT" },
  { key: "claude", label: "Claude" },
  { key: "gemini", label: "Gemini" },
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
  const [promptsText, setPromptsText] = useState("");
  const [schedule, setSchedule] = useState<"MANUAL" | "NIGHTLY" | "WEEKLY" | "MONTHLY">("MANUAL");
  const [ga4PropertyId, setGa4PropertyId] = useState("");
  const [gscSiteUrl, setGscSiteUrl] = useState("");
  const [platforms, setPlatforms] = useState<string[]>(["openai", "claude", "gemini"]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          promptsText,
          schedule,
          ga4PropertyId: ga4PropertyId || undefined,
          gscSiteUrl: gscSiteUrl || undefined,
          platforms,
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
      <div className="mx-auto max-w-2xl px-6 py-10">
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

          <div className="grid grid-cols-3 gap-4">
            <Field label="Schedule">
              <select
                value={schedule}
                onChange={(e) => setSchedule(e.target.value as typeof schedule)}
                className={inputClass}
              >
                <option value="MANUAL">Manual</option>
                <option value="NIGHTLY">Nightly</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </Field>
            <Field label="GA4 Property ID">
              <input
                type="text"
                value={ga4PropertyId}
                onChange={(e) => setGa4PropertyId(e.target.value)}
                className={inputClass}
                placeholder="Optional"
              />
            </Field>
            <Field label="GSC Site URL">
              <input
                type="text"
                value={gscSiteUrl}
                onChange={(e) => setGscSiteUrl(e.target.value)}
                className={inputClass}
                placeholder="Optional"
              />
            </Field>
          </div>

          <Field label="Platforms">
            <div className="flex gap-4">
              {PLATFORM_OPTIONS.map((p) => (
                <label
                  key={p.key}
                  className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300"
                >
                  <input
                    type="checkbox"
                    checked={platforms.includes(p.key)}
                    onChange={() => togglePlatform(p.key)}
                    className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
                  />
                  {p.label}
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
