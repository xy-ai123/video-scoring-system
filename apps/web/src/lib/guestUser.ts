/**
 * GuestUser persistence + bcrypt helpers.
 *
 * Symmetric with `lib/adminUser.ts` but for the per-main guest table.
 * Each guest row owns ONE allowed Drive main (e.g. "Hotel 77", "VNM").
 * The session cookie carries that string in `payload.allowedMain` so
 * server components can filter the dashboard + the detail page to
 * only the submissions whose resolved main matches.
 *
 * Module owns:
 *   - seedGuestUsers():    on first boot, creates hotel77/hotel77123 →
 *                           Hotel 77 and vnm/vnm123 → VNM if no guest
 *                           rows exist yet. Idempotent.
 *   - ensureGuestsSeeded(): once-per-process singleton wrapper.
 *   - verifyGuestPassword(): bcrypt-compare; returns row + allowedMain
 *                            on success.
 *   - listGuests / createGuest / updateGuest / deleteGuest: admin
 *     CRUD operations called from /api/admin/guests routes.
 *
 * Why a second table (not a single Users table with a role column)?
 * The admin table is internal-config-ish (one row, rarely changes,
 * different lifecycle — operators don't manage admin via the dashboard).
 * Guests are admin-managed data: created when a new main appears,
 * deleted when a contractor leaves, etc. Keeping them in separate
 * tables means CRUD on one can't accidentally clobber the other and
 * the schema for each is exactly what's needed.
 *
 * BCRYPT_ROUNDS is 8 (same as adminUser.ts) so the perf optimisation
 * from task #79 applies to guest login as well.
 */

import bcrypt from "bcryptjs";
import { prisma } from "@vss/db";

const BCRYPT_ROUNDS = 8;

/** Seed payloads, expanded inside seedGuestUsers(). Kept here so a
 *  reviewer can find the initial credentials in one place. */
const INITIAL_GUESTS: ReadonlyArray<{
  username: string;
  password: string;
  allowedMain: string;
}> = [
  { username: "hotel77", password: "hotel77123", allowedMain: "Hotel 77" },
  { username: "vnm", password: "vnm123", allowedMain: "VNM" },
];

/** In-memory cache for guest row lookups (parallel to adminUser.ts's
 *  cache). Keyed by lowercased username. */
type CachedGuestRow = {
  row:
    | {
        id: string;
        username: string;
        passwordHash: string;
        allowedMain: string;
      }
    | null;
};
const GUEST_CACHE_TTL_MS = 60_000;
let guestCache: {
  key: string;
  payload: CachedGuestRow;
  expiresAt: number;
} | null = null;

function getCachedGuestRow(usernameLowered: string): CachedGuestRow | null {
  if (!guestCache) return null;
  if (guestCache.key !== usernameLowered) return null;
  if (guestCache.expiresAt < Date.now()) {
    guestCache = null;
    return null;
  }
  return guestCache.payload;
}

function setCachedGuestRow(
  usernameLowered: string,
  row: CachedGuestRow["row"],
): void {
  guestCache = {
    key: usernameLowered,
    payload: { row },
    expiresAt: Date.now() + GUEST_CACHE_TTL_MS,
  };
}

/** Drop the cache. Called whenever a guest row is created / updated /
 *  deleted so the next login picks up the new state immediately. */
export function invalidateGuestCache(): void {
  guestCache = null;
}

/**
 * Idempotent seed. If the GuestUser table has zero rows, inserts the
 * two initial guest accounts (hotel77, vnm). Safe to call on every
 * server boot.
 */
export async function seedGuestUsers(): Promise<boolean> {
  const count = await prisma.guestUser.count();
  if (count > 0) return false;
  for (const g of INITIAL_GUESTS) {
    const hash = await bcrypt.hash(g.password, BCRYPT_ROUNDS);
    await prisma.guestUser.create({
      data: {
        username: g.username,
        passwordHash: hash,
        // Mirror plaintext for /admin/guests display. See schema.prisma
        // passwordPlain comment for the security note.
        passwordPlain: g.password,
        allowedMain: g.allowedMain,
      },
    });
  }
  return true;
}

let seedPromise: Promise<boolean> | null = null;
export function ensureGuestsSeeded(): Promise<boolean> {
  if (!seedPromise) {
    seedPromise = seedGuestUsers().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

/**
 * Validate a guest login. Returns the row's id, username, and
 * allowedMain on success, or null on failure. Constant-time-ish via
 * the dummy hash for non-existent usernames (same trick as
 * verifyAdminPassword).
 */
export async function verifyGuestPassword(
  username: string,
  password: string,
): Promise<{ id: string; username: string; allowedMain: string } | null> {
  const normalized = username.trim().toLowerCase();
  let row: CachedGuestRow["row"];
  const cached = getCachedGuestRow(normalized);
  if (cached) {
    row = cached.row;
  } else {
    row = await prisma.guestUser.findUnique({
      where: { username: normalized },
    });
    setCachedGuestRow(normalized, row);
  }
  const DUMMY_HASH =
    "$2a$10$0000000000000000000000xWcq.dQzAQBNGE3.Y3oG6yqM6vJyMnDe";
  const hash = row?.passwordHash ?? DUMMY_HASH;
  const ok = await bcrypt.compare(password, hash);
  if (!ok || !row) return null;
  return {
    id: row.id,
    username: row.username,
    allowedMain: row.allowedMain,
  };
}

// ---------------------------------------------------------------------------
// Admin-facing CRUD (called from /api/admin/guests routes).
// ---------------------------------------------------------------------------

/** Return all guest rows sorted by username for a stable UI order.
 *  Includes passwordPlain so /admin/guests can display it; null when
 *  the row was seeded before the column existed and the operator
 *  hasn't changed the password since (UI shows "—" in that case). */
export async function listGuests(): Promise<
  {
    id: string;
    username: string;
    allowedMain: string;
    passwordPlain: string | null;
    updatedAt: Date;
  }[]
> {
  return prisma.guestUser.findMany({
    select: {
      id: true,
      username: true,
      allowedMain: true,
      passwordPlain: true,
      updatedAt: true,
    },
    orderBy: { username: "asc" },
  });
}

/** Username validation reused by create + update so the rules can't
 *  drift between the two paths. */
function validateUsername(input: string): string {
  const u = input.trim().toLowerCase();
  // 2-char minimum so operator-friendly short names like "cm" (for the
  // "Restaurant CM" main) are usable. The character allowlist below is
  // the actual safety net — even 2-char usernames must be lowercase
  // alphanumeric + . _ -, so e.g. "1" is out and "ab" is in.
  if (u.length < 2 || u.length > 120) {
    throw new Error("Username must be 2–120 characters.");
  }
  if (!/^[a-z0-9._-]+$/.test(u)) {
    throw new Error(
      "Username can only contain lowercase letters, digits, '.', '_', or '-'.",
    );
  }
  return u;
}

function validatePassword(input: string): void {
  if (input.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }
  if (input.length > 200) {
    throw new Error("Password is too long (max 200 characters).");
  }
}

function validateAllowedMain(input: string): string {
  const m = input.trim();
  if (m.length < 1 || m.length > 200) {
    throw new Error("Allowed main must be 1–200 characters.");
  }
  return m;
}

/** Create a new guest. Throws on validation / uniqueness failure. */
export async function createGuest(input: {
  username: string;
  password: string;
  allowedMain: string;
}): Promise<{ id: string; username: string; allowedMain: string }> {
  const username = validateUsername(input.username);
  validatePassword(input.password);
  const allowedMain = validateAllowedMain(input.allowedMain);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  try {
    const row = await prisma.guestUser.create({
      data: {
        username,
        passwordHash,
        // Mirror plaintext for /admin/guests display.
        passwordPlain: input.password,
        allowedMain,
      },
      select: { id: true, username: true, allowedMain: true },
    });
    invalidateGuestCache();
    return row;
  } catch (err: unknown) {
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

/** Update a guest row. Any of the three fields may be omitted to leave
 *  it untouched. Throws on validation / uniqueness failure or if the
 *  row doesn't exist. */
export async function updateGuest(
  id: string,
  patch: {
    newUsername?: string;
    newPassword?: string;
    newAllowedMain?: string;
  },
): Promise<{ id: string; username: string; allowedMain: string }> {
  const data: {
    username?: string;
    passwordHash?: string;
    passwordPlain?: string;
    allowedMain?: string;
  } = {};
  if (patch.newUsername !== undefined) data.username = validateUsername(patch.newUsername);
  if (patch.newPassword !== undefined) {
    validatePassword(patch.newPassword);
    data.passwordHash = await bcrypt.hash(patch.newPassword, BCRYPT_ROUNDS);
    // Mirror plaintext on every password change so the /admin/guests
    // column stays in sync.
    data.passwordPlain = patch.newPassword;
  }
  if (patch.newAllowedMain !== undefined) {
    data.allowedMain = validateAllowedMain(patch.newAllowedMain);
  }
  if (Object.keys(data).length === 0) {
    const row = await prisma.guestUser.findUniqueOrThrow({
      where: { id },
      select: { id: true, username: true, allowedMain: true },
    });
    return row;
  }
  try {
    const row = await prisma.guestUser.update({
      where: { id },
      data,
      select: { id: true, username: true, allowedMain: true },
    });
    invalidateGuestCache();
    return row;
  } catch (err: unknown) {
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

/** Hard-delete a guest. Returns true on success, false if the row
 *  didn't exist (idempotent — caller treats either as success). */
export async function deleteGuest(id: string): Promise<boolean> {
  try {
    await prisma.guestUser.delete({ where: { id } });
    invalidateGuestCache();
    return true;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2025"
    ) {
      return false;
    }
    throw err;
  }
}
