import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, hashToken } from "@/lib/auth";
import { requireTeam } from "@/lib/viewer";
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Account page: a team member changes their own password. Every other session of theirs
 * is ended, so a password someone else saw stops working everywhere. (Client logins'
 * passwords are reset by the team on the Access page instead.)
 */
export async function POST(request: Request): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;

  const body = (await request.json().catch(() => ({}))) as { current?: unknown; next?: unknown };
  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";
  if (next.length < MIN_PASSWORD_LENGTH) {
    return Response.json({ error: `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
  }
  if (next === current) return Response.json({ error: "Pick a password different from the current one." }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: viewer.id }, select: { passwordHash: true } });
  if (!user || !(await verifyPassword(current, user.passwordHash))) {
    return Response.json({ error: "The current password isn't right." }, { status: 400 });
  }

  const thisSession = hashToken((await cookies()).get(SESSION_COOKIE)?.value ?? "");
  await prisma.$transaction([
    prisma.user.update({
      where: { id: viewer.id },
      data: { passwordHash: await hashPassword(next), mustChangePassword: false },
    }),
    prisma.session.deleteMany({ where: { userId: viewer.id, id: { not: thisSession } } }),
  ]);
  return Response.json({ ok: true });
}
