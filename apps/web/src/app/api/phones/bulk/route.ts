/**
 * Phone inventory — bulk create endpoint.
 *
 * POST /api/phones/bulk
 *   body: { phones: [{ internal, modelNumber, phoneSerial?, imei?, imei2?,
 *                      rentedOut?, rentedAt?, assignedUser?, notes? }, ...] }
 *
 * Strategy: process each row independently inside one transaction-per-row
 * (not one big transaction) so a typo on row 17 doesn't roll back rows 1-16.
 * Already-existing VPM codes are reported as "skipped" rather than failing
 * the whole batch — matches the dashboard's bulk-import UX where the
 * operator can re-paste the same list later with new rows added.
 *
 * Capped at 500 rows per request to keep response time bounded.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PhoneSchema = z.object({
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
  rentedAt: z.string().max(40).optional().default(""),
  assignedUser: z.string().max(120).optional().default(""),
  notes: z.string().max(2000).optional().default(""),
});

const BodySchema = z.object({
  phones: z.array(PhoneSchema).min(1).max(500),
});

function parseRentedAt(value: string | undefined): Date | null {
  if (!value) return null;
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

  // Pre-flight de-dup against the DB so we report skips correctly even
  // when the same VPM code shows up twice in the same paste.
  const internals = parsed.data.phones.map((p) => p.internal.trim());
  const existing = await prisma.phone.findMany({
    where: { internal: { in: internals } },
    select: { internal: true },
  });
  const existingSet = new Set(existing.map((p) => p.internal));

  // Track within-batch duplicates too — paste with the same VPM twice
  // should only insert the first one and report the second as skipped.
  const seenThisBatch = new Set<string>();

  const created: string[] = [];
  const skipped: { internal: string; reason: string }[] = [];
  const failed: { internal: string; error: string }[] = [];

  for (const raw of parsed.data.phones) {
    const internal = raw.internal.trim();
    if (existingSet.has(internal)) {
      skipped.push({ internal, reason: "already exists" });
      continue;
    }
    if (seenThisBatch.has(internal)) {
      skipped.push({ internal, reason: "duplicate within batch" });
      continue;
    }
    seenThisBatch.add(internal);

    try {
      const phone = await prisma.phone.create({
        data: {
          internal,
          modelNumber: raw.modelNumber.trim(),
          phoneSerial: raw.phoneSerial?.trim() || null,
          imei: raw.imei?.trim() || null,
          imei2: raw.imei2?.trim() || null,
          rentedOut: raw.rentedOut,
          rentedAt: parseRentedAt(raw.rentedAt),
          assignedUser: raw.assignedUser?.trim() || null,
          notes: raw.notes?.trim() || null,
        },
      });
      await prisma.auditLog.create({
        data: {
          actor: admin.user.email,
          action: "phone.bulk_create",
          target: phone.internal,
          payload: {
            internal: phone.internal,
            modelNumber: phone.modelNumber,
            rentedOut: phone.rentedOut,
            assignedUser: phone.assignedUser,
          },
        },
      });
      created.push(internal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ internal, error: message });
      logger.error(
        { err, internal, errMessage: message },
        "phone bulk create row failed",
      );
    }
  }

  logger.info(
    {
      actor: admin.user.email,
      requested: parsed.data.phones.length,
      created: created.length,
      skipped: skipped.length,
      failed: failed.length,
    },
    "phone bulk create complete",
  );

  return NextResponse.json({
    ok: failed.length === 0,
    requested: parsed.data.phones.length,
    created,
    skipped,
    failed,
  });
}
