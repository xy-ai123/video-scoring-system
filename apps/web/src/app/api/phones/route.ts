/**
 * Phone inventory — create endpoint.
 *
 * POST /api/phones
 *   body: { internal, modelNumber, phoneSerial?, imei?, imei2?, rentedOut?, notes? }
 *
 * Idempotency: `internal` is the primary key (the operator-assigned VPM
 * code). Re-posting an existing internal returns 409 — for updates, use
 * PATCH /api/phones/<internal>.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  // VPM code, eg "VPM0157". Allow letters + digits + dash/underscore so the
  // user can adopt a different convention later without code changes.
  internal: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, "internal may only contain letters, digits, _ and -"),
  modelNumber: z.string().min(1).max(60),
  phoneSerial: z.string().max(60).optional().default(""),
  imei: z.string().max(60).optional().default(""),
  imei2: z.string().max(60).optional().default(""),
  rentedOut: z.boolean().optional().default(false),
  // ISO date or datetime string ("2026-05-20" or full ISO). Empty / missing →
  // null. We don't auto-fill from rentedOut so operators can record the
  // actual rental date independently of when the row was edited.
  rentedAt: z.string().max(40).optional().default(""),
  assignedUser: z.string().max(120).optional().default(""),
  notes: z.string().max(2000).optional().default(""),
});

function parseRentedAt(value: string | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept "YYYY-MM-DD" from <input type="date"> as local midnight, plus full
  // ISO strings. Both round-trip through new Date() correctly enough for our
  // purposes; we don't care about sub-second precision.
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
  const data = parsed.data;
  const internal = data.internal.trim();

  try {
    const existing = await prisma.phone.findUnique({ where: { internal } });
    if (existing) {
      return NextResponse.json(
        { error: "conflict", message: `Phone "${internal}" already exists` },
        { status: 409 },
      );
    }
    const phone = await prisma.phone.create({
      data: {
        internal,
        modelNumber: data.modelNumber.trim(),
        // Empty strings -> null in the DB so we don't store useless ""s.
        phoneSerial: data.phoneSerial?.trim() || null,
        imei: data.imei?.trim() || null,
        imei2: data.imei2?.trim() || null,
        rentedOut: data.rentedOut,
        rentedAt: parseRentedAt(data.rentedAt),
        assignedUser: data.assignedUser?.trim() || null,
        notes: data.notes?.trim() || null,
      },
    });
    await prisma.auditLog.create({
      data: {
        actor: admin.user.email,
        action: "phone.create",
        target: phone.internal,
        payload: { ...data },
      },
    });
    logger.info(
      { internal: phone.internal, actor: admin.user.email },
      "phone created",
    );
    return NextResponse.json({ ok: true, phone });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, errMessage: message }, "phone create failed");
    const isDev = process.env.NODE_ENV === "development";
    return NextResponse.json(
      { error: "internal error", ...(isDev ? { devMessage: message } : {}) },
      { status: 500 },
    );
  }
}
