import { prisma } from "@/lib/prisma";
import { cleanTabs, sameEmail } from "@/lib/auth";
import { requireTeam } from "@/lib/viewer";
import { generatePassword, hashPassword } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Access page: creates a login with a generated password, which is returned once (only
 * its hash is stored).
 * - { role: "TEAM", email, name }: a team member, who must pick their own password at first sign-in.
 * - { role: "CLIENT", clientId, email, allowedTabs }: a client's one shared login.
 */
export async function POST(request: Request): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;

  const body = (await request.json().catch(() => ({}))) as {
    role?: unknown;
    email?: unknown;
    name?: unknown;
    clientId?: unknown;
    allowedTabs?: unknown;
  };
  const email = sameEmail(typeof body.email === "string" ? body.email : "");
  if (!EMAIL.test(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    return Response.json({ error: "That email already has a login." }, { status: 409 });
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  if (body.role === "TEAM") {
    const user = await prisma.user.create({
      data: { email, name, role: "TEAM", passwordHash, mustChangePassword: true },
      select: { id: true, email: true },
    });
    return Response.json({ user, password });
  }

  if (body.role === "CLIENT") {
    const clientId = typeof body.clientId === "string" ? body.clientId : "";
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { name: true, login: { select: { id: true } } },
    });
    if (!client) return Response.json({ error: "Client not found." }, { status: 404 });
    if (client.login) return Response.json({ error: `${client.name} already has a login.` }, { status: 409 });
    const user = await prisma.user.create({
      data: { email, name: client.name, role: "CLIENT", passwordHash, clientId, allowedTabs: cleanTabs(body.allowedTabs) },
      select: { id: true, email: true },
    });
    return Response.json({ user, password });
  }

  return Response.json({ error: "role must be TEAM or CLIENT." }, { status: 400 });
}
