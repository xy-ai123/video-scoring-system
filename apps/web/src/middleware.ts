import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verifySessionToken } from "@/lib/session";

/**
 * Role-aware cookie middleware.
 *
 * Route policy:
 *   /admin                  → admin OR guest
 *   /admin/*  (any subpath) → admin ONLY (clipping, analytics, export,
 *                              phones, trash, settings, submissions/:id,
 *                              etc.)
 *   /api/submissions/*      → admin ONLY (those routes mutate data; the
 *                              dashboard only fetches submissions via
 *                              server components, which check role
 *                              themselves)
 *
 * Unauth flow: pages redirect to /login?callbackUrl=<here>, APIs return
 * 401 JSON. Guest hitting an admin-only page also lands on /login with a
 * separate `error=guest_denied` hint so the UI can explain why.
 *
 * AUTH_BYPASS=true (dev only) still skips the gate entirely — bypass
 * resolves to admin role in `getCurrentUser()` for consistency.
 *
 * The webhook (/api/webhooks/google-form) is intentionally NOT in the
 * matcher — it authenticates via HMAC, not the cookie.
 */

// Never bypass in production, even if AUTH_BYPASS=true leaks into the env.
const BYPASS =
  process.env.AUTH_BYPASS === "true" &&
  process.env.NODE_ENV !== "production";

/** Returns true if the path is somewhere a guest can view. Two cases:
 *   1. /admin (the dashboard) — exactly, trailing slash tolerated
 *   2. /admin/submissions/<id> — individual submission detail page
 *
 * The detail page itself hides the Decision section + Danger zone for
 * guests and blurs scores while the submission is still SCORED, so
 * exposing the route is safe. Subpaths beyond <id> (none currently
 * exist) would still 403 — the regex anchors on `/?$`. */
function isGuestAllowedPath(pathname: string): boolean {
  if (pathname === "/admin" || pathname === "/admin/") return true;
  if (/^\/admin\/submissions\/[^/]+\/?$/.test(pathname)) return true;
  return false;
}

export async function middleware(req: NextRequest) {
  if (BYPASS) return NextResponse.next();

  const url = req.nextUrl;
  const isApi = url.pathname.startsWith("/api/");
  const token = req.cookies.get(COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);

  // No session at all → unauthenticated.
  if (!session) {
    if (isApi) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", url.pathname + url.search);
    return NextResponse.redirect(loginUrl);
  }

  // Admin role: full pass-through.
  if (session.role === "admin") return NextResponse.next();

  // Guest role: only /admin (the submissions dashboard) is permitted.
  // Everything else under /admin/*  is admin-only. Same logic for the
  // mutating /api/submissions/* routes.
  if (session.role === "guest") {
    if (isApi) {
      // Block all matched APIs for guests (the matcher only includes
      // /api/submissions/*, which is purely admin write surface).
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (!isGuestAllowedPath(url.pathname)) {
      // Bounce to /login with a hint so the UI can show a friendly
      // "this page is admin-only — sign in or stay in guest view"
      // message. callbackUrl preserves the original target so an
      // admin signing in lands on the page they wanted.
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("error", "guest_denied");
      loginUrl.searchParams.set("callbackUrl", url.pathname + url.search);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  // Unknown role (future-proofing — shouldn't happen with current types):
  // treat as unauthenticated.
  if (isApi) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: ["/admin/:path*", "/api/submissions/:path*"],
};
