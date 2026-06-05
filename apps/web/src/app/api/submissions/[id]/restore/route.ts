import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  // Defense-in-depth CSRF check. SameSite=Lax handles the common case, but a
  // strict Origin check stops cross-origin POSTs entirely.
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

  const id = params.id;
  const actor = admin.user.email;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.submission.findUnique({ where: { id } });
      if (!current) throw new Error("not_found");
      if (!current.deletedAt) {
        // Idempotent: not deleted, nothing to restore.
        return current;
      }

      const next = await tx.submission.update({
        where: { id },
        data: { deletedAt: null, deletedBy: null },
      });
      await tx.auditLog.create({
        data: {
          actor,
          action: "submission.restore",
          target: id,
          payload: {
            previouslyDeletedAt: current.deletedAt.toISOString(),
            previouslyDeletedBy: current.deletedBy,
          },
        },
      });
      return next;
    });

    logger.info({ submissionId: id, actor }, "submission restored");
    return NextResponse.json({ ok: true, submission: updated });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, errMessage: message, submissionId: id },
      "restore failed",
    );
    const isDev = process.env.NODE_ENV === "development";
    return NextResponse.json(
      {
        error: "internal error",
        ...(isDev ? { devMessage: message } : {}),
      },
      { status: 500 },
    );
  }
}
