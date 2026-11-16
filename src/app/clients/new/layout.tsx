import { requireTeamPage } from "@/lib/viewer";

// Add Client is a client component page, so the team-only check lives here.
export default async function NewClientLayout({ children }: { children: React.ReactNode }) {
  await requireTeamPage();
  return children;
}
