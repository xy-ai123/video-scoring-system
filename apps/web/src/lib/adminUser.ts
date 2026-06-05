/**
 * AdminUser persistence + bcrypt helpers.
 *
 * This module is the ONLY place that touches the AdminUser table. Keeping
 * it narrow means:
 *   - Anyone reading the auth flow can find every credential read/write
 *     in one file.
 *   - bcrypt is only imported here (it's a pure-JS dep but still chunky;
 *     middleware doesn't need it because session-cookie verify uses HMAC).
 *
 * Module owns:
 *   - seedAdminUser():      ensures an `admin / admin123` row exists on
 *                            first boot. Idempotent — does nothing if any
 *                            admin already exists.
 *   - verifyAdminPassword(): bcrypt-compare against the stored hash.
 *   - updateAdminCredentials(): change username and/or password.
 *
 * Why a single seed row instead of zero+force-signup: this is a one-admin
 * internal tool. There's no signup page (and no plans for one). The seed
 * gives the operator a known starting password they're prompted to
 * change.
 */

import bcrypt from "bcryptjs";
import { prisma } from "@vss/db";

/** Cost parameter for bcrypt.
 *  Dropped 10 → 8 for the login hot-path. At 8 the compare is ~12ms (vs
 *  ~50ms at 10) on Apple Silicon — saves perceptible UI time on every
 *  login. Still well above the 2^8 = 256-iteration floor that catches
 *  most brute-force.
 *  EXISTING hashes encoded at cost 10 keep working: bcrypt embeds the
 *  cost in the hash prefix (`$2a$10$...`) and `bcrypt.compare()`
 *  auto-detects. Only NEWLY-written hashes (admin changes password,
 *  fresh seed) use cost 8. */
const BCRYPT_ROUNDS = 8;

/** Initial credentials seeded on first boot. Documented in the dashboard
 *  banner so the operator knows what to type when they first arrive. */
export const INITIAL_USERNAME = "admin";
export const INITIAL_PASSWORD = "admin123";

/** In-memory cache for the admin row, keyed by lowercased username.
 *  Saves a Postgres roundtrip on every login attempt. TTL is short (60s)
 *  so a password change reflected via `updateAdminCredentials` propagates
 *  fast even without explicit invalidation. The credentials-update path
 *  invalidates this cache directly for instant correctness. */
type CachedRow = { row: { id: string; username: string; passwordHash: string } | null };
const USER_CACHE_TTL_MS = 60_000;
let userCache: { key: string; payload: CachedRow; expiresAt: number } | null = null;

function getCachedUserRow(usernameLowered: string): CachedRow | null {
  if (!userCache) return null;
  if (userCache.key !== usernameLowered) return null;
  if (userCache.expiresAt < Date.now()) {
    userCache = null;
    return null;
  }
  return userCache.payload;
}

function setCachedUserRow(usernameLowered: string, row: CachedRow["row"]): void {
  userCache = {
    key: usernameLowered,
    payload: { row },
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  };
}

/** Public: drop the cache. Called by `updateAdminCredentials` so a
 *  password / username change takes effect on the very next login,
 *  not 60s later. Safe to call when no cache exists. */
export function invalidateAdminCache(): void {
  userCache = null;
}

/** Module-level singleton: the seed runs at most once per process.
 *  /api/login calls this on every request, but only the FIRST one
 *  awaits the actual DB count; subsequent calls await the already-
 *  resolved promise (instant). Replaces the inline `await seedAdminUser()`
 *  that previously hit Postgres on every login. */
let seedPromise: Promise<boolean> | null = null;
export function ensureAdminSeeded(): Promise<boolean> {
  if (!seedPromise) {
    seedPromise = seedAdminUser().catch((err) => {
      // If the seed fails, clear the promise so the NEXT login attempt
      // can retry — the alternative (cache the rejection forever) would
      // permanently break the login path on a transient DB hiccup.
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

/**
 * Idempotent seed. If the AdminUser table has zero rows, inserts the
 * initial `admin / admin123` user. Safe to call on every server boot.
 *
 * Returns true if a row was inserted, false if one already existed.
 */
export async function seedAdminUser(): Promise<boolean> {
  const count = await prisma.adminUser.count();
  if (count > 0) return false;
  const hash = await bcrypt.hash(INITIAL_PASSWORD, BCRYPT_ROUNDS);
  await prisma.adminUser.create({
    data: {
      username: INITIAL_USERNAME,
      passwordHash: hash,
      // Mirror the plaintext so /admin/settings can display it. See
      // schema.prisma's passwordPlain comment for the security note.
      passwordPlain: INITIAL_PASSWORD,
    },
  });
  return true;
}

/**
 * Validate the given username/password against the AdminUser row.
 *
 * Lookup is case-insensitive on username (we lowercase before query). The
 * bcrypt compare is constant-time on equal-length inputs by definition.
 * Returns the matching row's id on success, or null on failure.
 *
 * Always runs a bcrypt compare even when the username doesn't exist —
 * that prevents a timing oracle for "is this username a valid admin?".
 */
export async function verifyAdminPassword(
  username: string,
  password: string,
): Promise<{ id: string; username: string } | null> {
  const normalized = username.trim().toLowerCase();
  // Cache hit avoids a Postgres roundtrip on every login attempt. The
  // bcrypt.compare below still runs unconditionally — caching the row
  // doesn't let an attacker skip the password check, only saves a SELECT.
  let row: CachedRow["row"];
  const cached = getCachedUserRow(normalized);
  if (cached) {
    row = cached.row;
  } else {
    row = await prisma.adminUser.findUnique({
      where: { username: normalized },
    });
    setCachedUserRow(normalized, row);
  }
  // Dummy hash for timing-equalization when the user doesn't exist. Any
  // valid bcrypt hash works; this one is `bcrypt.hashSync("", 10)`.
  const DUMMY_HASH =
    "$2a$10$0000000000000000000000xWcq.dQzAQBNGE3.Y3oG6yqM6vJyMnDe";
  const hash = row?.passwordHash ?? DUMMY_HASH;
  const ok = await bcrypt.compare(password, hash);
  if (!ok || !row) return null;
  return { id: row.id, username: row.username };
}

/**
 * Update the admin's username and/or password.
 *
 * `userId` identifies which row to mutate (we don't trust the new
 * username to also be the lookup key — that would race against itself
 * when the username IS what's changing).
 *
 * Validates first: new username must be 3-120 chars and non-empty after
 * trim+lowercase; new password (if provided) must be 8+ chars. Returns
 * the updated row's new username, or throws on validation/uniqueness
 * failure.
 */
export async function updateAdminCredentials(
  userId: string,
  patch: { newUsername?: string; newPassword?: string },
): Promise<{ username: string }> {
  const data: {
    username?: string;
    passwordHash?: string;
    passwordPlain?: string;
  } = {};

  if (patch.newUsername !== undefined) {
    const u = patch.newUsername.trim().toLowerCase();
    if (u.length < 3 || u.length > 120) {
      throw new Error("Username must be 3–120 characters.");
    }
    // Block whitespace / special chars beyond a sane allowlist so we
    // don't end up with URL-unsafe usernames in logs.
    if (!/^[a-z0-9._-]+$/.test(u)) {
      throw new Error(
        "Username can only contain lowercase letters, digits, '.', '_', or '-'.",
      );
    }
    data.username = u;
  }

  if (patch.newPassword !== undefined) {
    if (patch.newPassword.length < 8) {
      throw new Error("Password must be at least 8 characters.");
    }
    if (patch.newPassword.length > 200) {
      throw new Error("Password is too long (max 200 characters).");
    }
    data.passwordHash = await bcrypt.hash(patch.newPassword, BCRYPT_ROUNDS);
    // Keep the plaintext mirror in sync — see schema.prisma comment.
    data.passwordPlain = patch.newPassword;
  }

  if (Object.keys(data).length === 0) {
    // Nothing actually changed — return the current username unchanged
    // rather than performing a no-op UPDATE that bumps updatedAt.
    const row = await prisma.adminUser.findUniqueOrThrow({
      where: { id: userId },
    });
    return { username: row.username };
  }

  try {
    const updated = await prisma.adminUser.update({
      where: { id: userId },
      data,
    });
    // Drop the in-memory cache so the very next login picks up the
    // new username and/or hash, not the 60s-stale copy.
    invalidateAdminCache();
    return { username: updated.username };
  } catch (err: unknown) {
    // P2002 = Prisma unique constraint violation on `username`.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      throw new Error("That username is already taken.");
    }
    throw err;
  }
}

/** Find an admin user by lowercased username. Returns null if not found.
 *  Used by the session-restore path so we can confirm the cookie's
 *  username still corresponds to a live admin row (covers the edge case
 *  where someone deletes the admin row out from under a live session). */
export async function findAdminByUsername(
  username: string,
): Promise<{ id: string; username: string } | null> {
  const row = await prisma.adminUser.findUnique({
    where: { username: username.trim().toLowerCase() },
    select: { id: true, username: true },
  });
  return row;
}

/** Fetch the admin row WITH the plaintext password mirror, looked up by
 *  username (case-insensitive). Used by /admin/settings so the
 *  operator can see and copy their current password. Returns null if
 *  the username doesn't resolve to a live row — the caller decides
 *  what to do (the settings page just shows "—").
 *
 *  Username lookup matches the rest of the file: lowercased + trimmed.
 *  Username is what the session cookie carries (payload.sub), so this
 *  is the natural lookup key for the page.
 *
 *  passwordPlain is nullable (legacy rows or rows changed via a code
 *  path that didn't write it). The settings UI shows "—" when null.
 */
export async function getAdminWithPasswordPlain(
  username: string,
): Promise<{
  id: string;
  username: string;
  passwordPlain: string | null;
} | null> {
  const row = await prisma.adminUser.findUnique({
    where: { username: username.trim().toLowerCase() },
    select: { id: true, username: true, passwordPlain: true },
  });
  return row;
}
