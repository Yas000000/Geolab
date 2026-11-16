import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Logins: sessions and the access rules. Shared by src/proxy.ts (which gates every
 * request) and src/lib/viewer.ts (which pages and route handlers use), so the two
 * can never disagree about who may open what.
 *
 * TEAM: everything. CLIENT: only its own client's tabs listed in allowedTabs, never
 * Settings, never an API call (other than logging out).
 */

export const SESSION_COOKIE = "geo_session";
export const SESSION_DAYS = 30;

/** The tabs a client login can be given, in the sidebar's order. Settings is never one of them. */
export const CLIENT_TABS = [
  { segment: "traffic", label: "GEO Traffic" },
  { segment: "rankings", label: "GEO Rankings" },
  { segment: "citations", label: "Citations" },
  { segment: "outreach", label: "Outreach Plan" },
  { segment: "competitors", label: "Competitors" },
  { segment: "reports", label: "Reports" },
] as const;
export type ClientTab = (typeof CLIENT_TABS)[number]["segment"];
const TAB_SET = new Set<string>(CLIENT_TABS.map((t) => t.segment));

/** Keeps only real client tabs, in sidebar order. */
export function cleanTabs(tabs: unknown): ClientTab[] {
  const wanted = new Set(Array.isArray(tabs) ? tabs.filter((t): t is string => typeof t === "string") : []);
  return CLIENT_TABS.map((t) => t.segment).filter((s) => wanted.has(s) && TAB_SET.has(s));
}

export interface Viewer {
  id: string;
  email: string;
  name: string | null;
  role: "TEAM" | "CLIENT";
  clientId: string | null;
  allowedTabs: ClientTab[];
  mustChangePassword: boolean;
}

/** A session's database id: the sha256 of its cookie token. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { id: hashToken(token), userId, expiresAt } });
  return { token, expiresAt };
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.session.deleteMany({ where: { id: hashToken(token) } });
}

/** The signed-in user behind a session cookie, or null when it's missing, expired or no longer valid. */
export async function sessionViewer(token: string | undefined): Promise<Viewer | null> {
  if (!token || token.length > 200) return null;
  const session = await prisma.session.findUnique({
    where: { id: hashToken(token) },
    select: {
      expiresAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          clientId: true,
          allowedTabs: true,
          disabledAt: true,
          mustChangePassword: true,
          client: { select: { archivedAt: true } },
        },
      },
    },
  });
  if (!session || session.expiresAt < new Date()) return null;
  const u = session.user;
  if (u.disabledAt) return null;
  // A client login stops working while its client is archived (and the client must still exist).
  if (u.role === "CLIENT" && (!u.clientId || !u.client || u.client.archivedAt)) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    clientId: u.clientId,
    allowedTabs: cleanTabs(u.allowedTabs),
    mustChangePassword: u.mustChangePassword,
  };
}

/** Where a viewer lands after signing in, or when they open a page they can't see. */
export function homePath(viewer: Viewer): string {
  if (viewer.role === "TEAM") return viewer.mustChangePassword ? "/account" : "/clients";
  const first = viewer.allowedTabs[0];
  return first ? `/clients/${viewer.clientId}/${first}` : `/clients/${viewer.clientId}`;
}

/** Whether a client login may open this path: its own client's landing page or one of its allowed tabs. */
export function clientMayOpen(viewer: Viewer, pathname: string): boolean {
  if (viewer.role !== "CLIENT" || !viewer.clientId) return false;
  const base = `/clients/${viewer.clientId}`;
  if (pathname === base) return true;
  if (!pathname.startsWith(`${base}/`)) return false;
  const rest = pathname.slice(base.length + 1);
  return !rest.includes("/") && (viewer.allowedTabs as string[]).includes(rest);
}

/** A relative path to send someone back to after signing in; anything else falls back to home. */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  return next;
}

export const sameEmail = (email: string) => email.trim().toLowerCase();
