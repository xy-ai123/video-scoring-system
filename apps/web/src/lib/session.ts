/**
 * Tiny signed-cookie session for the admin dashboard.
 *
 * Cookie format: `<base64url-payload>.<base64url-signature>` where
 *   payload   = JSON.stringify({ sub, iat, exp })
 *   signature = HMAC-SHA256(payload, NEXTAUTH_SECRET)
 *
 * Implementation uses the Web Crypto API (globalThis.crypto.subtle) so it
 * works in both Node.js routes and the Edge-runtime middleware.
 */

export const COOKIE_NAME = "vss-session";
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/** Two roles. Admin is the full-access account (DB-backed). Guest is the
 *  no-credentials read-only account that's identified purely by the
 *  signed cookie itself (no DB row). Treated as separate concepts in
 *  middleware + UI gates. */
export type Role = "admin" | "guest";

export type SessionPayload = {
  /** Subject — the admin's username, or the guest's username (e.g.
   *  "hotel77", "vnm"). The literal "guest" appears in legacy cookies
   *  issued before per-main guest accounts existed. */
  sub: string;
  /** Which authorization tier this session has. NEW field — old cookies
   *  written before the guest role existed will be missing this; the
   *  verify path defaults them to "admin" so existing admin sessions
   *  don't get bumped out mid-browse after deploy. */
  role: Role;
  /** Guest sessions only: the Drive main folder this guest is scoped
   *  to ("Hotel 77" / "VNM" / etc.). Server components filter the
   *  submissions list + the detail-page lookup to this value.
   *  Undefined for admin sessions. */
  allowedMain?: string;
  /** Issued at (ms since epoch). */
  iat: number;
  /** Expires at (ms since epoch). */
  exp: number;
};

function getSecret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "NEXTAUTH_SECRET must be set (>=16 chars) to sign session cookies",
    );
  }
  return s;
}

// NOTE: credential validation now lives in `lib/adminUser.ts`
// (verifyAdminPassword) — backed by the AdminUser Postgres table with
// bcrypt-hashed passwords. The legacy env-var pair (ADMIN_USERNAME /
// ADMIN_PASSWORD) is no longer consulted because operators need to be
// able to change creds from the dashboard without a redeploy.
//
// The DB-backed verify path is exported from this file as
// `validateCredentials()` for backwards compat with `/api/login`, and
// the cookie sign/verify primitives below are unchanged.

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa is available in both Node 18+ and Edge.
  const b64 = typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bytes).toString("base64");
  return b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function importKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signMessage(message: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToB64url(new Uint8Array(sig));
}

async function verifyMessage(
  message: string,
  signatureB64url: string,
  secret: string,
): Promise<boolean> {
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlToBytes(signatureB64url);
  } catch {
    return false;
  }
  const key = await importKey(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(message),
  );
}

/** Build a fresh signed session token for the given subject + role.
 *  - admin: sub = the admin's username (case-normalized lowercase),
 *            role = "admin", allowedMain undefined
 *  - guest: sub = the guest's username (e.g. "hotel77"), role = "guest",
 *            allowedMain = the Drive main folder this guest scopes to
 *  The role is what middleware + getCurrentUser() reads to decide what
 *  the session can do; sub is mostly for display ("hello, hotel77"). */
export async function createSessionToken(
  sub: string,
  role: Role = "admin",
  opts: { allowedMain?: string; ttlMs?: number } = {},
): Promise<string> {
  const ttlMs = opts.ttlMs ?? TWELVE_HOURS_MS;
  const now = Date.now();
  const payload: SessionPayload = {
    sub,
    role,
    iat: now,
    exp: now + ttlMs,
    ...(opts.allowedMain !== undefined ? { allowedMain: opts.allowedMain } : {}),
  };
  const json = JSON.stringify(payload);
  const payloadB64 = bytesToB64url(new TextEncoder().encode(json));
  const sig = await signMessage(payloadB64, getSecret());
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a session token. Returns the payload if valid, otherwise null.
 * Uses Web Crypto's constant-time `verify` op. Rejects expired tokens.
 */
export async function verifySessionToken(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, providedSig] = parts;
  if (!payloadB64 || !providedSig) return null;
  // Sig must be base64url chars only.
  if (!/^[A-Za-z0-9_-]+$/.test(providedSig)) return null;

  let ok: boolean;
  try {
    ok = await verifyMessage(payloadB64, providedSig, getSecret());
  } catch {
    return null;
  }
  if (!ok) return null;

  let parsed: SessionPayload;
  try {
    const json = new TextDecoder().decode(b64urlToBytes(payloadB64));
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.sub !== "string" ||
    typeof parsed.iat !== "number" ||
    typeof parsed.exp !== "number"
  ) {
    return null;
  }
  if (Date.now() > parsed.exp) return null;
  // Back-compat: old cookies (pre-role) don't carry a `role` field. Treat
  // them as admin so existing admin sessions keep working after deploy.
  // Going forward, every new token writes the field explicitly.
  if (parsed.role !== "admin" && parsed.role !== "guest") {
    parsed.role = "admin";
  }
  // Guest sessions MUST carry an allowedMain string. Pre-per-main
  // "anonymous guest" cookies (legacy task-#78 era) had no allowedMain
  // and used to mean "guest sees all mains" — that mode no longer
  // exists. Treat them as invalid so the holder is forced to re-login
  // via the new credentialed form. Without this guard, an old cookie
  // would slip through with allowedMain=undefined and bypass the
  // dashboard's per-main filter.
  if (parsed.role === "guest" && typeof parsed.allowedMain !== "string") {
    return null;
  }
  return parsed;
}

/**
 * Validate admin username/password against the AdminUser DB table.
 *
 * Returns the matched admin's identity on success, null on failure.
 * The actual bcrypt compare lives in `lib/adminUser.ts` — this is a
 * thin wrapper for backwards compat with /api/login + so callers don't
 * have to know about the bcrypt dep.
 *
 * NB this is now async (was sync against env vars). All call sites have
 * been updated to await it.
 */
export async function validateCredentials(
  username: string | undefined | null,
  password: string | undefined | null,
): Promise<{ id: string; username: string } | null> {
  if (typeof username !== "string" || typeof password !== "string") return null;
  // Lazy import so the bcrypt dependency only loads on the login path,
  // not on every session-cookie verify (cookies only need HMAC).
  const { verifyAdminPassword } = await import("./adminUser");
  return verifyAdminPassword(username, password);
}

/**
 * Cookie options. The `secure` flag is decided per-request because dev runs
 * over both http://localhost (where `secure: true` would drop the cookie)
 * AND https://*.ngrok-free.dev (where Safari is strict about non-Secure
 * cookies and silently drops them under ITP). The caller passes the
 * `x-forwarded-proto` header (set by ngrok) or the request URL scheme.
 */
export function cookieOptions(opts: { isSecureRequest: boolean }) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: opts.isSecureRequest,
    maxAge: Math.floor(TWELVE_HOURS_MS / 1000),
  };
}

/** Detect whether the incoming request is over HTTPS as seen by the browser. */
export function isHttpsRequest(req: Request): boolean {
  // ngrok / Vercel / typical reverse-proxies set this header.
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim().toLowerCase() === "https";
  // Fall back to the request URL.
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Backwards-compat: a static options object that picks Secure based on
 * NODE_ENV. Prefer the per-request `cookieOptions()` above where you have
 * access to the Request, which handles dev-over-ngrok-HTTPS correctly.
 */
export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: Math.floor(TWELVE_HOURS_MS / 1000),
};
