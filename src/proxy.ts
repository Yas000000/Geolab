import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, clientMayOpen, homePath, sessionViewer } from "@/lib/auth";

/**
 * The login gate in front of every page and API route (Next.js 16 Proxy, Node.js runtime).
 *
 * - Open to anyone: the login page and its API, and /report/... links (so a report can
 *   still be sent to someone without a login).
 * - Checked by their own secret instead of a login: the cron routes (CRON_SECRET), the
 *   queue consumer (Vercel's own), the Python functions and the outreach build's next step
 *   (src/lib/internal-key.ts).
 * - Everything else needs a signed-in session. A team login may open anything. A client
 *   login may open only its own client's allowed tabs (and log out); anything else sends it
 *   back to its own first tab, or answers 403 for an API call.
 *
 * Every page and route also checks again next to its data (src/lib/viewer.ts).
 */

const OPEN = [/^\/login$/, /^\/api\/auth\/login$/, /^\/report\/[^/]+$/, /^\/privacy$/];
const OWN_SECRET = [
  /^\/api\/cron\//,
  /^\/api\/queues\//,
  /^\/api\/(run_pipeline|outreach|crawl_check)$/,
  /^\/api\/clients\/[^/]+\/outreach\/step$/,
];
const CLIENT_API = [/^\/api\/auth\/logout$/];

function deny(request: NextRequest, isApi: boolean, status: number, to: string, message: string) {
  if (isApi) return NextResponse.json({ error: message }, { status });
  return NextResponse.redirect(new URL(to, request.url));
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (OPEN.some((r) => r.test(pathname)) || OWN_SECRET.some((r) => r.test(pathname))) return NextResponse.next();

  const isApi = pathname.startsWith("/api/");

  // A changing API call from another site is refused, whoever is signed in. (The session
  // cookie is SameSite=Lax, so browsers don't send it on those anyway; this is a second lock.)
  if (isApi && request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.nextUrl.host) {
      return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
    }
  }

  const viewer = await sessionViewer(request.cookies.get(SESSION_COOKIE)?.value);
  if (!viewer) {
    const next = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    const res = deny(request, isApi, 401, `/login${next}`, "Sign in first.");
    // A cookie that no longer matches a session (expired, logged out elsewhere) is cleared.
    if (request.cookies.has(SESSION_COOKIE)) res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  if (viewer.role === "TEAM") {
    // A generated password has to be replaced before anything else.
    const passwordPaths = pathname === "/account" || pathname.startsWith("/api/auth/");
    if (viewer.mustChangePassword && !passwordPaths) {
      return deny(request, isApi, 403, "/account", "Choose a new password first.");
    }
    return NextResponse.next();
  }

  if (CLIENT_API.some((r) => r.test(pathname)) || (!isApi && clientMayOpen(viewer, pathname))) {
    return NextResponse.next();
  }
  return deny(request, isApi, 403, homePath(viewer), "Not allowed.");
}

export const config = {
  // Everything except Next.js's own static files and images.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt)$).*)"],
};
