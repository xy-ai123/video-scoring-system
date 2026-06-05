/**
 * Phone inventory — update endpoint.
 *
 * PATCH /api/phones/<internal>
 *   body: any subset of { modelNumber, phoneSerial, imei, imei2, rentedOut, notes }
 *
 * The primary key `internal` is intentionally NOT editable here — if the
 * operator picked the wrong VPM code, they can delete + recreate.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every field is optional — caller can patch just the rentedOut flag, or
// fix a typo in modelNumber, without re-posting the whole row.
const BodySchema = z.object({
  modelNumber: z.string().min(1).max(60).optional(),
  phoneSerial: z.string().max(60).optional(),
  imei: z.string().max(60).optional(),
  imei2: z.string().max(60).optional(),
  rentedOut: z.boolean().optional(),
  // Empty string explicitly clears the date; absent key leaves it unchanged.
  rentedAt: z.string().max(40).optional(),
  assignedUser: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: { internal: string } },
) {
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
  const data = parsed.data;
  const internal = params.internal;

  // Build the update payload from only the fields the client actually sent.
  // Empty strings normalize to null so we don't store whitespace.
  // Use the narrow primitive union Prisma's JSON column accepts, so
  // logging the same object to AuditLog.payload typechecks cleanly.
  const update: Record<string, string | boolean | Date | null> = {};
  if (data.modelNumber !== undefined) update.modelNumber = data.modelNumber.trim();
  if (data.phoneSerial !== undefined)
    update.phoneSerial = data.phoneSerial.trim() || null;
  if (data.imei !== undefined) update.imei = data.imei.trim() || null;
  if (data.imei2 !== undefined) update.imei2 = data.imei2.trim() || null;
  if (data.rentedOut !== undefined) update.rentedOut = data.rentedOut;
  if (data.rentedAt !== undefined) update.rentedAt = parseRentedAt(data.rentedAt);
  if (data.assignedUser !== undefined)
    update.assignedUser = data.assignedUser.trim() || null;
  if (data.notes !== undefined) update.notes = data.notes.trim() || null;

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "invalid body", message: "no fields to update" },
      { status: 400 },
    );
  }

  try {
    const before = await prisma.phone.findUnique({ where: { internal } });
    if (!before) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const phone = await prisma.phone.update({
      where: { internal },
      data: update,
    });
    await prisma.auditLog.create({
      data: {
        actor: admin.user.email,
        action: "phone.update",
        target: internal,
        payload: { changed: update },
      },
    });
    logger.info(
      { internal, actor: admin.user.email, changed: Object.keys(update) },
      "phone updated",
    );
    return NextResponse.json({ ok: true, phone });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, errMessage: message, internal },
      "phone update failed",
    );
    const isDev = process.env.NODE_ENV === "development";
    return NextResponse.json(
      { error: "internal error", ...(isDev ? { devMessage: message } : {}) },
      { status: 500 },
    );
  }
}
