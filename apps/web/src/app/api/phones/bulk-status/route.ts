/**
 * Phone inventory — bulk rented-out toggle.
 *
 * POST /api/phones/bulk-status
 *   body: { internals: string[], rentedOut: boolean, rentedAt?: string }
 *
 * Sets `rentedOut` (and optionally `rentedAt`) for every phone whose
 * Internal (VPM code) is in the supplied list. Returns counts so the UI
 * can show "Updated 12 phones (3 unchanged)".
 *
 * Semantics:
 *   - rentedOut=true + rentedAt provided  → mark rented + set the date
 *   - rentedOut=true + rentedAt omitted   → mark rented, leave date alone
 *   - rentedOut=false                     → mark available, *clear* date
 *                                            and `assignedUser` (so a
 *                                            recycled phone doesn't carry
 *                                            stale renter info)
 *
 * One audit-log entry per phone, so the standard audit trail in the DB
 * keeps a per-VPM history of who flipped what when.
 *
 * Capped at 500 internals per request — same ceiling as /api/phones/bulk
 * for symmetry and predictable latency.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  internals: z
    .array(
      z
        .string()
        .min(1)
        .max(40)
        .regex(/^[A-Za-z0-9_-]+$/),
    )
    .min(1)
    .max(500),
  rentedOut: z.boolean(),
  rentedAt: z.string().max(40).optional(),
});

function parseRentedAt(value: string | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(trimmed);
  if (dateOnly) {
    const [y, m, d] = trimmed.split("-").map(Number);
    // Local-time midnight so YYYY-MM-DD from an <input type="date"> doesn't
    // jump a day for operators east of UTC.
    return new Date(y!, m! - 1, d!);
  }
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function csrfCheck(req: NextRequest): NextResponse | null {
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
  return null;
}

export async function POST(req: NextRequest) {
  const csrf = csrfCheck(req);
  if (csrf) return csrf;

  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // De-dup before hitting the DB; an accidentally duplicated VPM in the
  // payload still only generates one update + one audit row.
  const uniqueInternals = Array.from(new Set(parsed.data.internals));
  const newRentedAt =
    parsed.data.rentedOut === false
      ? null // marking as available always clears the date
      : parseRentedAt(parsed.data.rentedAt);
  // Distinguish "omit rentedAt" (don't touch) from "clear rentedAt".
  // When rentedOut=false → always clear.
  // When rentedOut=true  → only touch when caller sent a value.
  const shouldUpdateRentedAt =
    parsed.data.rentedOut === false || parsed.data.rentedAt !== undefined;

  const existing = await prisma.phone.findMany({
    where: { internal: { in: uniqueInternals } },
    select: {
      internal: true,
      rentedOut: true,
      rentedAt: true,
      assignedUser: true,
    },
  });
  const existingMap = new Map(existing.map((p) => [p.internal, p]));

  let updated = 0;
  let skipped = 0; // already at the target state, nothing to do
  let notFound = 0;
  const updates: { internal: string; before: typeof existing[number]; after: { rentedOut: boolean; rentedAt: Date | null; assignedUser: string | null } }[] = [];

  for (const internal of uniqueInternals) {
    const before = existingMap.get(internal);
    if (!before) {
      notFound += 1;
      continue;
    }

    // Compute the would-be state so we can skip no-op updates and not
    // pollute the audit log with rows where nothing actually changed.
    const afterRentedOut = parsed.data.rentedOut;
    const afterRentedAt = shouldUpdateRentedAt ? newRentedAt : before.rentedAt;
    const afterAssignedUser =
      parsed.data.rentedOut === false ? null : before.assignedUser;

    const noChange =
      before.rentedOut === afterRentedOut &&
      ((before.rentedAt?.getTime() ?? null) ===
        (afterRentedAt?.getTime() ?? null)) &&
      before.assignedUser === afterAssignedUser;
    if (noChange) {
      skipped += 1;
      continue;
    }

    updates.push({
      internal,
      before,
      after: {
        rentedOut: afterRentedOut,
        rentedAt: afterRentedAt,
        assignedUser: afterAssignedUser,
      },
    });
  }

  // Apply in a transaction so we either flip the whole batch or nothing —
  // partial flips during a Postgres hiccup would leave the inventory
  // confusingly half-rented. Audit rows are written in the same txn for
  // the same reason.
  if (updates.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        for (const u of updates) {
          await tx.phone.update({
            where: { internal: u.internal },
            data: {
              rentedOut: u.after.rentedOut,
              ...(shouldUpdateRentedAt ? { rentedAt: u.after.rentedAt } : {}),
              ...(parsed.data.rentedOut === false
                ? { assignedUser: null }
                : {}),
            },
          });
          await tx.auditLog.create({
            data: {
              actor: admin.user.email,
              action: "phone.bulk_status",
              target: u.internal,
              payload: {
                rentedOutBefore: u.before.rentedOut,
                rentedOutAfter: u.after.rentedOut,
                rentedAtBefore: u.before.rentedAt
                  ? u.before.rentedAt.toISOString()
                  : null,
                rentedAtAfter: u.after.rentedAt
                  ? u.after.rentedAt.toISOString()
                  : null,
                assignedUserBefore: u.before.assignedUser,
                assignedUserAfter: u.after.assignedUser,
              },
            },
          });
        }
      });
      updated = updates.length;
    } catch (err) {
      logger.error({ err }, "phone bulk status transaction failed");
      return NextResponse.json(
        { error: "db_error", message: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }

  logger.info(
    {
      actor: admin.user.email,
      rentedOut: parsed.data.rentedOut,
      requested: uniqueInternals.length,
      updated,
      skipped,
      notFound,
    },
    "phone bulk status complete",
  );

  return NextResponse.json({
    ok: true,
    requested: uniqueInternals.length,
    updated,
    skipped,
    notFound,
  });
}
