/**
 * A section's explanation note: a light blue panel with a small round "i" (the user's
 * pick, 2026-11-23, option A of the note-style mockups). Section titles use the same blue
 * as the circle (text-blue-600, dark: blue-500). The "i" is drawn, not typed, so it never
 * depends on a font. No hooks, so server and client components can both use it.
 * `className` carries the spacing the old note paragraph had (e.g. "mb-3").
 */
export function InfoNote({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg bg-blue-50 px-3.5 py-3 text-xs leading-relaxed text-[#1e3a5f] dark:bg-[#0b1a33] dark:text-blue-200 ${className}`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="mt-px h-4 w-4 flex-none">
        <circle cx="8" cy="8" r="8" className="fill-blue-600 dark:fill-blue-500" />
        <circle cx="8" cy="4.6" r="1.15" className="fill-white dark:fill-[#0b1a33]" />
        <rect x="7.05" y="6.7" width="1.9" height="5.8" rx="0.95" className="fill-white dark:fill-[#0b1a33]" />
      </svg>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
