/**
 * Bulk set the Category on many submissions at once.
 *
 * POST /api/submissions/bulk-category
 *   body: { ids: string[], category: string }
 *
 * Empty string is rejected — submissions always need a category (it's
 * required at form / Drive-folder ingest time too). Soft-deleted rows are
 * skipped: editing a trashed row's category would be surprising, and the
 * trash flow has its own restore-first path.
 *
 * Mirrors the shape of /api/submissions/bulk-pic so the audit log + UI
 * stay consistent across the bulk endpoints.
 *
 * Capped at 500 ids per request for symmetry with the other bulk routes.
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
  // Category is required and non-empty — we don't support clearing it.
  // The 100-char ceiling matches the Submission.category column.
  category: z.string().min(1).max(100),
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
  const nextValue = parsed.data.category.trim();
  const actor = admin.user.email;

  const existing = await prisma.submission.findMany({
    where: { id: { in: uniqueIds }, deletedAt: null },
    select: { id: true, category: true },
  });
  const existingMap = new Map(existing.map((s) => [s.id, s]));

  const toUpdate: { id: string; previous: string }[] = [];
  let skipped = 0;
  let notFound = 0;
  for (const id of uniqueIds) {
    const row = existingMap.get(id);
    if (!row) {
      notFound += 1;
      continue;
    }
    if (row.category === nextValue) {
      skipped += 1;
      continue;
    }
    toUpdate.push({ id, previous: row.category });
  }

  if (toUpdate.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        for (const u of toUpdate) {
          await tx.submission.update({
            where: { id: u.id },
            data: { category: nextValue },
          });
          await tx.auditLog.create({
            data: {
              actor,
              action: "submission.bulk_category",
              target: u.id,
              payload: {
                previousCategory: u.previous,
                newCategory: nextValue,
              },
            },
          });
        }
      });
    } catch (err) {
      logger.error({ err }, "submission bulk category transaction failed");
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
      category: nextValue,
    },
    "submission bulk category complete",
  );

  return NextResponse.json({
    ok: true,
    requested: uniqueIds.length,
    updated: toUpdate.length,
    skipped,
    notFound,
  });
}
