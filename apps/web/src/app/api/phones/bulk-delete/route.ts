/**
 * Phone inventory — bulk delete.
 *
 * POST /api/phones/bulk-delete
 *   body: { internals: string[] }
 *
 * Hard-deletes every phone whose Internal (VPM code) is in the supplied
 * list. Phones are hardware inventory rather than user content, so we
 * don't need a soft-delete / trash flow — but we *do* keep one audit-log
 * row per deletion so the deletion is recoverable from the audit trail if
 * the operator needs to recreate the row later (the audit payload records
 * every field that was on the phone at delete time).
 *
 * Capped at 500 internals per request for symmetry with the other bulk
 * routes. The whole batch deletes in a single transaction so a Postgres
 * hiccup mid-loop doesn't leave the inventory half-deleted.
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

  // Fetch the rows we're about to delete first so the audit log can store
  // a snapshot of each phone — if someone deletes 50 phones by mistake,
  // they can rebuild the inventory from the audit history.
  const existing = await prisma.phone.findMany({
    where: { internal: { in: uniqueInternals } },
  });
  const foundSet = new Set(existing.map((p) => p.internal));
  const notFound = uniqueInternals.filter((id) => !foundSet.has(id));

  if (existing.length === 0) {
    return NextResponse.json({
      ok: true,
      requested: uniqueInternals.length,
      deleted: 0,
      notFound: notFound.length,
    });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.phone.deleteMany({
        where: { internal: { in: existing.map((p) => p.internal) } },
      });
      for (const p of existing) {
        await tx.auditLog.create({
          data: {
            actor: admin.user.email,
            action: "phone.bulk_delete",
            target: p.internal,
            // Stringify all the snapshot values so the payload fits the
            // narrow `string | boolean | null` JSON shape used elsewhere.
            payload: {
              internal: p.internal,
              modelNumber: p.modelNumber,
              phoneSerial: p.phoneSerial,
              imei: p.imei,
              imei2: p.imei2,
              rentedOut: p.rentedOut,
              rentedAt: p.rentedAt ? p.rentedAt.toISOString() : null,
              assignedUser: p.assignedUser,
              notes: p.notes,
            },
          },
        });
      }
    });
  } catch (err) {
    logger.error({ err }, "phone bulk delete transaction failed");
    return NextResponse.json(
      {
        error: "db_error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  logger.info(
    {
      actor: admin.user.email,
      requested: uniqueInternals.length,
      deleted: existing.length,
      notFound: notFound.length,
    },
    "phone bulk delete complete",
  );

  return NextResponse.json({
    ok: true,
    requested: uniqueInternals.length,
    deleted: existing.length,
    notFound: notFound.length,
  });
}
