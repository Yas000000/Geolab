import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy Policy · GEO Reporting Portal" };

// Public page (listed as open in src/proxy.ts). Google's OAuth consent screen links here.
export default function PrivacyPage() {
  return (
    <div className="flex flex-1 justify-center bg-zinc-50 px-4 py-16 dark:bg-black">
      <div className="w-full max-w-2xl space-y-5 rounded-xl border border-zinc-200 bg-white px-6 py-8 text-sm leading-6 text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
        <div>
          <h1 className="text-xl font-semibold text-zinc-950 dark:text-zinc-50">Privacy Policy</h1>
          <p className="mt-1 text-zinc-500 dark:text-zinc-400">GEO Reporting Portal · Updated November 19, 2026</p>
        </div>

        <p>
          GEO Reporting Portal is a private reporting tool our agency uses to report on our clients&apos; visibility in AI
          search and their website traffic. Only our team and the clients we give a login to can sign in.
        </p>

        <h2 className="pt-2 text-base font-semibold text-zinc-950 dark:text-zinc-50">Google data we access</h2>
        <p>
          When our agency&apos;s Google account is connected, the portal asks Google for read-only access to Google Analytics
          and Google Search Console, plus that account&apos;s email address. It cannot change any Google Analytics or Search
          Console settings or data.
        </p>

        <h2 className="pt-2 text-base font-semibold text-zinc-950 dark:text-zinc-50">How we use it</h2>
        <p>
          The portal reads daily website totals for our clients&apos; sites (such as sessions, users, key events, search clicks,
          impressions and average position) and saves them so they can be shown in that client&apos;s reports. It keeps the
          connected account&apos;s email address and the sign-in token Google issues so the daily update can run.
        </p>
        <p>
          We do not sell this data, use it for advertising or share it with anyone other than the client the data belongs
          to. Our use of information received from Google APIs follows the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="text-zinc-950 underline dark:text-zinc-50"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>

        <h2 className="pt-2 text-base font-semibold text-zinc-950 dark:text-zinc-50">Removing access</h2>
        <p>
          Access can be removed at any time from the Google account&apos;s{" "}
          <a href="https://myaccount.google.com/permissions" className="text-zinc-950 underline dark:text-zinc-50">
            third-party access page
          </a>
          . A client&apos;s saved data is deleted when that client is deleted from the portal.
        </p>

        <h2 className="pt-2 text-base font-semibold text-zinc-950 dark:text-zinc-50">Contact</h2>
        <p>
          Questions about this policy can be sent to{" "}
          <a href="mailto:seop.analytics@gmail.com" className="text-zinc-950 underline dark:text-zinc-50">
            seop.analytics@gmail.com
          </a>
          .
        </p>
      </div>
    </div>
  );
}
