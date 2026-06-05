/**
 * Server-side session helpers — the single source of truth for "who is
 * currently signed in?" decisions across server components, route
 * handlers, and the middleware (which uses `verifySessionToken`
 * directly).
 *
 * Roles:
 *   - "admin" — DB-backed (AdminUser table), full access.
 *   - "guest" — cookie-only, read-only. Hits a button on /login, gets
 *                a signed cookie with role=guest. No password.
 *
 * Public API:
 *   getCurrentUser()  → { role, username, expires } | null
 *   getCurrentAdmin() → AdminSession | null  (back-compat — null if guest)
 *
 * Bypass mode:
 *   AUTH_BYPASS=true + NODE_ENV != "production" still works for local
 *   debugging. Bypass returns an ADMIN session so the dev experience is
 *   unchanged. Production deploys ignore the flag.
 */

export type Role = "admin" | "guest";

export type UserSession = {
  role: Role;
  /** Admin sessions: the admin's username. Guest sessions: the guest
   *  account's username (e.g. "hotel77", "vnm"). */
  username: string;
  /** Guest sessions only: the Drive main folder this guest is scoped
   *  to (e.g. "Hotel 77", "VNM"). Used by server components to filter
   *  the submissions list + the detail page to a single main.
   *  Undefined for admin sessions (admin sees everything). */
  allowedMain?: string;
  /** ISO timestamp of session expiry. */
  expires: string;
};

/** Back-compat shape kept for places that haven't migrated to UserSession yet. */
export type AdminSession = {
  user: {
    email: string;
    name?: string | null;
    isAdmin: true;
  };
  expires: string;
};

const BYPASS_ENABLED =
  process.env.AUTH_BYPASS === "true" &&
  process.env.NODE_ENV !== "production";

/**
 * Returns the current user's session (admin OR guest) or null.
 *
 * Internally reads the signed cookie set by /api/login (admin) or
 * /api/auth/guest (guest). Used by server components and route
 * handlers that need role-aware behavior.
 */
export async function getCurrentUser(): Promise<UserSession | null> {
  if (BYPASS_ENABLED) {
    return {
      role: "admin",
      username: "bypass-admin",
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }
  const { cookies } = await import("next/headers");
  const { COOKIE_NAME, verifySessionToken } = await import("./session");
  const token = cookies().get(COOKIE_NAME)?.value;
  const payload = await verifySessionToken(token);
  if (!payload) return null;
  return {
    role: payload.role,
    username: payload.sub,
    // payload.allowedMain is present only for guest sessions; admin
    // sessions leave the field undefined. The verifySessionToken
    // guard rejects guest cookies missing the field, so by this point
    // a role-=guest session is guaranteed to carry one.
    allowedMain: payload.allowedMain,
    expires: new Date(payload.exp).toISOString(),
  };
}

/**
 * Back-compat wrapper: returns the session iff the user is an admin.
 * Guest sessions resolve to null here so existing admin-only callsites
 * keep working without any code changes.
 */
export async function getCurrentAdmin(): Promise<AdminSession | null> {
  const u = await getCurrentUser();
  if (!u || u.role !== "admin") return null;
  return {
    user: {
      email: u.username,
      name: u.username,
      isAdmin: true,
    },
    expires: u.expires,
  };
}
