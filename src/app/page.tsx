import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 dark:bg-black">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
          GEO Reporting Portal
        </h1>
        <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
          Track AI visibility across ChatGPT, Claude, and Gemini for every client and brand
          you run.
        </p>
        <Link
          href="/clients"
          className="mt-2 inline-flex items-center rounded-full bg-zinc-950 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          View Clients
        </Link>
      </div>
    </div>
  );
}
