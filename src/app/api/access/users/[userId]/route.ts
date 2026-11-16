import { prisma } from "@/lib/prisma";
import { cleanTabs, sameEmail } from "@/lib/auth";
import { requireTeam } from "@/lib/viewer";
import { generatePassword, hashPassword } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PatchBody {
  email?: unknown;
  name?: unknown;
  allowedTabs?: unknown; // client logins only
  disabled?: unknown;
  resetPassword?: unknown;
}

/**
 * Access page: changes one login. A password reset returns the new generated password
 * once; a reset or turning a login off also signs it out everywhere.
 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/access/users/[userId]">): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { userId } = await ctx.params;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, email: true } });
  if (!user) return Response.json({ error: "Login not found." }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as PatchBody;
  const data: {
    email?: string;
    name?: string | null;
    allowedTabs?: string[];
    disabledAt?: Date | null;
    passwordHash?: string;
    mustChangePassword?: boolean;
    failedLogins?: number;
    lockedUntil?: null;
  } = {};
  let signOut = false;
  let password: string | null = null;

  if (typeof body.email === "string") {
    const email = sameEmail(body.email);
    if (!EMAIL.test(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
    if (email !== user.email) {
      if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
        return Response.json({ error: "That email already has a login." }, { status: 409 });
      }
      data.email = email;
    }
  }
  if (typeof body.name === "string") data.name = body.name.trim() || null;
  if (body.allowedTabs !== undefined) {
    if (user.role !== "CLIENT") return Response.json({ error: "Only client logins have tab settings." }, { status: 400 });
    data.allowedTabs = cleanTabs(body.allowedTabs);
  }
  if (typeof body.disabled === "boolean") {
    if (body.disabled && user.id === viewer.id) {
      return Response.json({ error: "You can't turn off your own login." }, { status: 400 });
    }
    data.disabledAt = body.disabled ? new Date() : null;
    if (body.disabled) signOut = true;
  }
  if (body.resetPassword === true) {
    password = generatePassword();
    data.passwordHash = await hashPassword(password);
    data.mustChangePassword = user.role === "TEAM";
    data.failedLogins = 0;
    data.lockedUntil = null;
    signOut = true;
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data }),
    ...(signOut ? [prisma.session.deleteMany({ where: { userId: user.id } })] : []),
  ]);
  return Response.json({ ok: true, password });
}

/** Access page: removes a login for good (its sessions go with it). */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/access/users/[userId]">): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { userId } = await ctx.params;
  if (userId === viewer.id) return Response.json({ error: "You can't remove your own login." }, { status: 400 });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) return Response.json({ error: "Login not found." }, { status: 404 });
  await prisma.user.delete({ where: { id: userId } });
  return Response.json({ ok: true });
}
