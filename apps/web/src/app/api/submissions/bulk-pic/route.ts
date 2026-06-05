/**
 * Bulk set the Person-in-Charge name on many submissions at once.
 *
 * POST /api/submissions/bulk-pic
 *   body: { ids: string[], personInCharge: string }
 *
 * Empty `personInCharge` clears the PIC field (mirrors the single-id
 * /api/submissions/[id]/pic route). Soft-deleted submissions are skipped
 * — operators usually only want to edit PIC on live rows, and editing a
 * trashed row would surprise them.
 *
 * One audit row per actually-changed submission, so the per-row history
 * the dashboard relies on stays accurate. No-op updates (PIC already set
 * to the requested value) are skipped to keep the audit log clean.
 *
 * Capped at 500 ids per request for symmetry with the bulk phone endpoints.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  ids: z.array(z.string().min(1).max(40)).min(1).max(500),
  // Same shape as the single-PIC route — empty string clears.
  personInCharge: z.string().max(120),
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

  const uniqueIds = Array.from(new Set(parsed.data.ids));
  const trimmed = parsed.data.personInCharge.trim();
  const nextValue = trimmed.length === 0 ? null : trimmed;
  const actor = admin.user.email;

  // Live (not soft-deleted) rows only — operators editing a trashed
  // submission's PIC would be surprising, and the trash page has its
  // own restore-first flow.
  const existing = await prisma.submission.findMany({
    where: { id: { in: uniqueIds }, deletedAt: null },
    select: { id: true, personInCharge: true },
  });
  const existingMap = new Map(existing.map((s) => [s.id, s]));

  const toUpdate: { id: string; previous: string | null }[] = [];
  let skipped = 0; // already at the target value
  let notFound = 0; // not in DB or soft-deleted
  for (const id of uniqueIds) {
    const row = existingMap.get(id);
    if (!row) {
      notFound += 1;
      continue;
    }
    if (row.personInCharge === nextValue) {
      skipped += 1;
      continue;
    }
    toUpdate.push({ id, previous: row.personInCharge });
  }

  if (toUpdate.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        for (const u of toUpdate) {
          await tx.submission.update({
            where: { id: u.id },
            data: { personInCharge: nextValue },
          });
          await tx.auditLog.create({
            data: {
              actor,
              action: "submission.bulk_pic",
              target: u.id,
              payload: {
                previousPersonInCharge: u.previous,
                newPersonInCharge: nextValue,
              },
            },
          });
        }
      });
    } catch (err) {
      logger.error({ err }, "submission bulk PIC transaction failed");
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
      actor,
      requested: uniqueIds.length,
      updated: toUpdate.length,
      skipped,
      notFound,
      personInCharge: nextValue,
    },
    "submission bulk PIC complete",
  );

  return NextResponse.json({
    ok: true,
    requested: uniqueIds.length,
    updated: toUpdate.length,
    skipped,
    notFound,
  });
}
