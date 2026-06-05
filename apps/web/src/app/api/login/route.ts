import { NextResponse } from "next/server";
import { z } from "zod";
import {
  COOKIE_NAME,
  cookieOptions,
  createSessionToken,
  isHttpsRequest,
  validateCredentials,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  username: z.string().min(1).max(120),
  password: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// In-memory IP-keyed rate limiter: 10 failures per 10 minutes per IP.
// Adds a constant-time 250ms delay on every 4xx so success/failure paths take
// roughly the same wall-clock time and brute-force throughput is capped.
// ---------------------------------------------------------------------------
type Bucket = { fails: number; resetAt: number };
const ATTEMPTS = new Map<string, Bucket>();
const MAX_FAILS = 10;
const WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_DELAY_MS = 250;

function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0]?.trim() || "unknown";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function recordFailure(ip: string) {
  const now = Date.now();
  const b = ATTEMPTS.get(ip);
  if (!b || b.resetAt < now) ATTEMPTS.set(ip, { fails: 1, resetAt: now + WINDOW_MS });
  else b.fails += 1;
}

function clearAttempts(ip: string) {
  ATTEMPTS.delete(ip);
}

function isBlocked(ip: string): boolean {
  const b = ATTEMPTS.get(ip);
  if (!b) return false;
  if (b.resetAt < Date.now()) {
    ATTEMPTS.delete(ip);
    return false;
  }
  return b.fails >= MAX_FAILS;
}

export async function POST(req: Request) {
  // Defense-in-depth CSRF check. SameSite=Lax handles the common case, but a
  // strict Origin check stops cross-origin POSTs entirely.
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

  const ip = getClientIp(req);
  if (isBlocked(ip)) {
    await sleep(LOCKOUT_DELAY_MS);
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Don't penalize for malformed-body errors — those are typically
    // accidents (e.g. wrong content-type, dev tools, server hiccups) and
    // would otherwise spuriously lock out legitimate admins when the build
    // fails.
    await sleep(LOCKOUT_DELAY_MS);
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    await sleep(LOCKOUT_DELAY_MS);
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Run the initial admin/admin123 + guest seeds at most once per
  // server process. Previously these would have hit Postgres for a
  // COUNT(*) every login; the `ensureXxxSeeded()` singletons cache
  // the first call's promise so subsequent logins skip the roundtrip.
  // Both wrapped in try-catch so a transient DB hiccup doesn't 500
  // the login path — verify steps below will still reject and surface
  // the right error to the user.
  try {
    const [{ ensureAdminSeeded }, { ensureGuestsSeeded }] = await Promise.all([
      import("@/lib/adminUser"),
      import("@/lib/guestUser"),
    ]);
    await Promise.all([ensureAdminSeeded(), ensureGuestsSeeded()]);
  } catch {
    // swallow
  }

  const { username, password } = parsed.data;
  // Try the admin table first. Most logins are admin in practice
  // (operators outnumber guests), and the bcrypt cost of one false
  // attempt is negligible. If admin fails, fall through to the guest
  // table.
  const adminMatched = await validateCredentials(username, password);
  if (adminMatched) {
    clearAttempts(ip);
    const token = await createSessionToken(adminMatched.username, "admin");
    const res = NextResponse.json({ ok: true, redirectTo: "/admin" });
    res.cookies.set(
      COOKIE_NAME,
      token,
      cookieOptions({ isSecureRequest: isHttpsRequest(req) }),
    );
    return res;
  }

  // Guest table fallback. Returns the row's id, username, AND
  // allowedMain so we can embed the main in the cookie payload.
  const { verifyGuestPassword } = await import("@/lib/guestUser");
  const guestMatched = await verifyGuestPassword(username, password);
  if (!guestMatched) {
    recordFailure(ip);
    await sleep(LOCKOUT_DELAY_MS);
    return NextResponse.json(
      { error: "invalid_credentials" },
      { status: 401 },
    );
  }

  clearAttempts(ip);
  const token = await createSessionToken(guestMatched.username, "guest", {
    allowedMain: guestMatched.allowedMain,
  });
  const res = NextResponse.json({ ok: true, redirectTo: "/admin" });
  res.cookies.set(
    COOKIE_NAME,
    token,
    cookieOptions({ isSecureRequest: isHttpsRequest(req) }),
  );
  return res;
}
