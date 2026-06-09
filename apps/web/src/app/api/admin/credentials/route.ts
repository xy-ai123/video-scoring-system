import { NextResponse } from "next/server";
import { z } from "zod";
import {
  COOKIE_NAME,
  cookieOptions,
  createSessionToken,
  isHttpsRequest,
} from "@/lib/session";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/credentials
 *
 * Body: { currentPassword: string, newUsername?: string, newPassword?: string }
 *
 * Updates the signed-in admin's username and/or password. Requires
 * `currentPassword` to be supplied so an attacker who steals a session
 * cookie can't change the password to lock out the real admin without
 * also knowing the existing one.
 *
 * On success the response includes a fresh session cookie reflecting
 * the new canonical username (so /admin/settings stays signed-in even
 * if the username changed).
 *
 * Guest sessions are 403'd. Admin role required.
 */

const BodySchema = z.object({
  currentPassword: z.string().min(1).max(200),
  // 2-char minimum mirrors guest username rules — same character
  // allowlist + same lower bound. See lib/adminUser.ts.
  newUsername: z.string().min(2).max(120).optional(),
  newPassword: z.string().min(8).max(200).optional(),
});

export async function POST(req: Request) {
  // Same-origin CSRF check.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "bad_origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "bad_origin" }, { status: 403 });
    }
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.role !== "admin") {
    return NextResponse.json({ error: "admin_only" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { currentPassword, newUsername, newPassword } = parsed.data;

  // Must supply at least one thing to change.
  if (!newUsername && !newPassword) {
    return NextResponse.json(
      { error: "no_changes", message: "Provide newUsername and/or newPassword." },
      { status: 400 },
    );
  }

  // Re-authenticate with the current password — defense against a stolen
  // session cookie used to change creds.
  const { verifyAdminPassword, updateAdminCredentials, findAdminByUsername } =
    await import("@/lib/adminUser");
  const matched = await verifyAdminPassword(user.username, currentPassword);
  if (!matched) {
    return NextResponse.json(
      { error: "wrong_password" },
      { status: 401 },
    );
  }

  // Apply the change. updateAdminCredentials throws on validation /
  // uniqueness failures; surface those as 400 with a readable message.
  let updated: { username: string };
  try {
    updated = await updateAdminCredentials(matched.id, {
      newUsername,
      newPassword,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "validation_error", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 400 },
    );
  }

  // If the username actually changed, look it up via findAdminByUsername
  // to confirm the row is still queryable (sanity check) and then issue
  // a fresh cookie with the new sub. If only the password changed, we
  // could leave the cookie alone, but re-issuing it bumps the TTL which
  // is a nice side effect after a security-relevant action.
  const verifyRow = await findAdminByUsername(updated.username);
  if (!verifyRow) {
    // Shouldn't happen — we just wrote the row. Treat as a server error.
    return NextResponse.json({ error: "post_update_lookup_failed" }, { status: 500 });
  }

  const token = await createSessionToken(updated.username, "admin");
  const res = NextResponse.json({ ok: true, username: updated.username });
  res.cookies.set(
    COOKIE_NAME,
    token,
    cookieOptions({ isSecureRequest: isHttpsRequest(req) }),
  );
  return res;
}
