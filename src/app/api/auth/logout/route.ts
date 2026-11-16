import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, destroySession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Log out": ends this browser's session. */
export async function POST(): Promise<Response> {
  await destroySession((await cookies()).get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ redirect: "/login" });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
