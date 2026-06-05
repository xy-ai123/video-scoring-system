/**
 * Phone inventory — bulk rented-at date update.
 *
 * POST /api/phones/bulk-date
 *   body: { internals: string[], rentedAt: string }
 *
 * Sets `rentedAt` for every phone whose Internal (VPM code) is in the
 * supplied list, *without* touching `rentedOut` or `assignedUser`. Used
 * when the operator realizes a batch of phones was given to participants
 * on a different day than originally recorded, or just wants to back-fill
 * dates on phones that were already marked rented but had no date.
 *
 * Empty-string `rentedAt` clears the date (mirrors the per-phone PATCH).
 *
 * Capped at 500 internals per request for symmetry with the other bulk
 * routes and predictable latency.
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
  // Use a string-typed field (rather than z.date()) so the JSON wire
  // format stays plain YYYY-MM-DD — matches every other bulk endpoint.
  // Empty string is allowed and means "clear the date".
  rentedAt: z.string().max(40),
});

function parseRentedAt(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(trimmed);
  if (dateOnly) {
    const [y, m, d] = trimmed.split("-").map(Number);
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

  const uniqueInternals = Array.from(new Set(parsed.data.internals));
  const newRentedAt = parseRentedAt(parsed.data.rentedAt);

  const existing = await prisma.phone.findMany({
    where: { internal: { in: uniqueInternals } },
    select: { internal: true, rentedAt: true },
  });
  const existingMap = new Map(existing.map((p) => [p.internal, p]));

  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  const updates: {
    internal: string;
    before: Date | null;
    after: Date | null;
  }[] = [];

  for (const internal of uniqueInternals) {
    const before = existingMap.get(internal);
    if (!before) {
      notFound += 1;
      continue;
    }
    // Skip if the recorded date already matches — keeps the audit log
    // clean and saves a write.
    if ((before.rentedAt?.getTime() ?? null) === (newRentedAt?.getTime() ?? null)) {
      skipped += 1;
      continue;
    }
    updates.push({ internal, before: before.rentedAt, after: newRentedAt });
  }

  if (updates.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        for (const u of updates) {
          await tx.phone.update({
            where: { internal: u.internal },
            data: { rentedAt: u.after },
          });
          await tx.auditLog.create({
            data: {
              actor: admin.user.email,
              action: "phone.bulk_date",
              target: u.internal,
              payload: {
                rentedAtBefore: u.before ? u.before.toISOString() : null,
                rentedAtAfter: u.after ? u.after.toISOString() : null,
              },
            },
          });
        }
      });
      updated = updates.length;
    } catch (err) {
      logger.error({ err }, "phone bulk date transaction failed");
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
      rentedAt: parsed.data.rentedAt,
    },
    "phone bulk date complete",
  );

  return NextResponse.json({
    ok: true,
    requested: uniqueInternals.length,
    updated,
    skipped,
    notFound,
  });
}
