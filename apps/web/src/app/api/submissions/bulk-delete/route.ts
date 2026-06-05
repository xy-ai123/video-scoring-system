/**
 * Bulk soft-delete submissions.
 *
 * POST /api/submissions/bulk-delete
 *   body: { ids: string[], reason?: string }
 *
 * Soft-delete only (sets deletedAt + deletedBy) — matches the single-id
 * /api/submissions/[id]/delete route. Trashed rows can be restored from
 * /admin/trash exactly the same way as one-by-one deletions.
 *
 * Already-deleted rows are silently treated as success (idempotent), so a
 * retry after a flaky network doesn't error out. Rows that don't exist
 * are reported as `notFound` so the UI can surface that to the operator.
 *
 * Capped at 500 ids per request for symmetry with the other bulk endpoints.
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
  reason: z.string().max(500).optional(),
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
  const actor = admin.user.email;
  const reason = parsed.data.reason ?? null;

  const existing = await prisma.submission.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, status: true, deletedAt: true },
  });
  const existingMap = new Map(existing.map((s) => [s.id, s]));

  const toDelete: { id: string; previousStatus: string }[] = [];
  let alreadyDeleted = 0;
  let notFound = 0;
  for (const id of uniqueIds) {
    const row = existingMap.get(id);
    if (!row) {
      notFound += 1;
      continue;
    }
    if (row.deletedAt) {
      // Idempotent: already in the trash, treat as a successful no-op so
      // the UI can show "deleted N" without a spurious failure count.
      alreadyDeleted += 1;
      continue;
    }
    toDelete.push({ id, previousStatus: row.status });
  }

  if (toDelete.length > 0) {
    try {
      const deletedAt = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.submission.updateMany({
          where: { id: { in: toDelete.map((u) => u.id) } },
          data: { deletedAt, deletedBy: actor },
        });
        for (const u of toDelete) {
          await tx.auditLog.create({
            data: {
              actor,
              action: "submission.bulk_delete",
              target: u.id,
              payload: {
                previousStatus: u.previousStatus,
                reason,
              },
            },
          });
        }
      });
    } catch (err) {
      logger.error({ err }, "submission bulk delete transaction failed");
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
      deleted: toDelete.length,
      alreadyDeleted,
      notFound,
    },
    "submission bulk delete complete",
  );

  return NextResponse.json({
    ok: true,
    requested: uniqueIds.length,
    deleted: toDelete.length,
    alreadyDeleted,
    notFound,
  });
}
