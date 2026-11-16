import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, clientMayOpen, homePath, sessionViewer, type ClientTab, type Viewer } from "@/lib/auth";

/**
 * Who is signed in, for pages and route handlers. src/proxy.ts already turns away
 * anyone who may not open a path; these checks repeat it next to the data, so a page
 * or route stays protected even if the proxy's path rules ever change.
 */

export const getViewer = cache(async (): Promise<Viewer | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return sessionViewer(token);
});

/** For route handlers: the team viewer, or the reply to send instead. */
export async function requireTeam(): Promise<Viewer | Response> {
  const viewer = await getViewer();
  if (!viewer) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (viewer.role !== "TEAM") return Response.json({ error: "Not allowed." }, { status: 403 });
  return viewer;
}

/** For team-only pages (client list, Settings, Access, run results, ...). */
export async function requireTeamPage(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.role !== "TEAM") redirect(homePath(viewer));
  return viewer;
}

/** For a client tab page: team members see every tab; a client login only its own allowed ones. */
export async function requireTab(clientId: string, tab: ClientTab | "settings"): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.role === "TEAM") return viewer;
  if (tab === "settings" || !clientMayOpen(viewer, `/clients/${clientId}/${tab}`)) redirect(homePath(viewer));
  return viewer;
}
