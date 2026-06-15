/**
 * Phone inventory — bulk assigned-user update.
 *
 * POST /api/phones/bulk-user
 *   body: { internals: string[], assignedUser: string }
 *
 * Sets `assignedUser` for every phone whose Internal (VPM code) is in the
 * supplied list, *without* touching `rentedOut`, `rentedAt`, or any other
 * field. Used when an operator hands a batch of phones to a single
 * participant in one go and doesn't want to per-row click-edit each one.
 *
 * Empty-string `assignedUser` clears the field (mirrors per-phone PATCH +
 * the bulk-date "empty clears" convention). 120-char cap matches the
 * single-row schema in /api/phones/route.ts.
 *
 * Capped at 500 internals per request for symmetry with bulk-date /
 * bulk-status / bulk-delete and predictable latency.
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
  // Plain string so JSON wire stays simple. Empty allowed and means
  // "clear the field". 120-char cap matches /api/phones single-row schema.
  assignedUser: z.string().max(120),
});

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

  const uniqueInternals = Array.from(new Set(parsed.data.internals));
  // Empty string → null in DB. Same rule as single-row create/edit and as
  // bulk-date does for empty dates.
  const newAssignedUser = parsed.data.assignedUser.trim() || null;

  const existing = await prisma.phone.findMany({
    where: { internal: { in: uniqueInternals } },
    select: { internal: true, assignedUser: true },
  });
  const existingMap = new Map(existing.map((p) => [p.internal, p]));

  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  const updates: {
    internal: string;
    before: string | null;
    after: string | null;
  }[] = [];

  for (const internal of uniqueInternals) {
    const before = existingMap.get(internal);
    if (!before) {
      notFound += 1;
      continue;
    }
    // Skip rows that already match — keeps audit log clean + saves a
    // write. Note both before AND after are nullable strings here.
    if ((before.assignedUser ?? null) === newAssignedUser) {
      skipped += 1;
      continue;
    }
    updates.push({
      internal,
      before: before.assignedUser ?? null,
      after: newAssignedUser,
    });
  }

  if (updates.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        for (const u of updates) {
          await tx.phone.update({
            where: { internal: u.internal },
            data: { assignedUser: u.after },
          });
          await tx.auditLog.create({
            data: {
              actor: admin.user.email,
              action: "phone.bulk_user",
              target: u.internal,
              payload: {
                assignedUserBefore: u.before,
                assignedUserAfter: u.after,
              },
            },
          });
        }
      });
      updated = updates.length;
    } catch (err) {
      logger.error({ err }, "phone bulk user transaction failed");
      return NextResponse.json(
        {
          error: "db_error",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
  }

  logger.info(
    {
      actor: admin.user.email,
      requested: uniqueInternals.length,
      updated,
      skipped,
      notFound,
      assignedUser: newAssignedUser,
    },
    "phone bulk user complete",
  );

  return NextResponse.json({
    ok: true,
    requested: uniqueInternals.length,
    updated,
    skipped,
    notFound,
  });
}
