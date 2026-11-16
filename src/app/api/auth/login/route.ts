import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, clientMayOpen, cleanTabs, createSession, homePath, safeNext, sameEmail, type Viewer } from "@/lib/auth";
import { dummyPasswordHash, verifyPassword } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FAILED = 10;
const LOCK_MINUTES = 15;
const WRONG = "That email and password don't match.";

/** The login page's form: checks the password and starts a 30-day session. */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown; next?: unknown };
  const email = sameEmail(typeof body.email === "string" ? body.email : "");
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return Response.json({ error: "Enter your email and password." }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { email },
    include: { client: { select: { archivedAt: true } } },
  });
  if (!user) {
    await verifyPassword(password, await dummyPasswordHash()); // same delay as a wrong password
    return Response.json({ error: WRONG }, { status: 401 });
  }

  const now = new Date();
  if (user.lockedUntil && user.lockedUntil > now) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000);
    return Response.json(
      { error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
      { status: 429 },
    );
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data:
        failed >= MAX_FAILED
          ? { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) }
          : { failedLogins: failed },
    });
    return Response.json({ error: WRONG }, { status: 401 });
  }

  // Only someone with the right password learns that a login is turned off.
  if (user.disabledAt) return Response.json({ error: "This login has been turned off." }, { status: 403 });
  if (user.role === "CLIENT" && (!user.clientId || !user.client || user.client.archivedAt)) {
    return Response.json({ error: "This login isn't active right now. Please contact your account team." }, { status: 403 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now },
  });
  const { token, expiresAt } = await createSession(user.id);

  const viewer: Viewer = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    clientId: user.clientId,
    allowedTabs: cleanTabs(user.allowedTabs),
    mustChangePassword: user.mustChangePassword,
  };
  const next = safeNext(typeof body.next === "string" ? body.next : null);
  let to = homePath(viewer);
  if (next && !viewer.mustChangePassword) {
    const nextPath = new URL(next, "http://x").pathname;
    if (viewer.role === "TEAM" || clientMayOpen(viewer, nextPath)) to = next;
  }

  const res = NextResponse.json({ redirect: to });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  return res;
}
