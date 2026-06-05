import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { enqueueNotification } from "@/lib/queue";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  notes: z.string().max(2000).optional(),
  personInCharge: z.string().min(1).max(120).optional(),
  // Free-text reason for the rejection. Optional at the schema level so
  // legacy clients don't break; the UI requires it before submitting.
  rejectReason: z.string().min(1).max(2000).optional(),
});

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
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const id = params.id;
  const actor = admin.user.email;

  let transitioned = false;
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.submission.findUnique({ where: { id } });
      if (!current) throw new Error("not_found");

      const wasAlreadyRejected = current.status === "REJECTED";
      transitioned = !wasAlreadyRejected;
      const next = await tx.submission.update({
        where: { id },
        data: {
          status: "REJECTED",
          reviewedAt: wasAlreadyRejected
            ? (current.reviewedAt ?? new Date())
            : new Date(),
          reviewedBy: actor,
          notes: parsed.data.notes ?? current.notes,
          ...(parsed.data.personInCharge != null
            ? { personInCharge: parsed.data.personInCharge.trim() }
            : {}),
          // Only overwrite the reason when one is supplied. Re-rejecting
          // (or just editing notes on an already-rejected row) without
          // re-typing the reason should preserve the existing one.
          ...(parsed.data.rejectReason != null
            ? { rejectReason: parsed.data.rejectReason.trim() }
            : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          actor,
          action: wasAlreadyRejected
            ? "submission.reject.update"
            : current.status === "APPROVED"
              ? "submission.reject.from_approved"
              : "submission.reject",
          target: id,
          payload: {
            previousStatus: current.status,
            notes: parsed.data.notes ?? null,
            personInCharge: parsed.data.personInCharge ?? null,
            rejectReason: parsed.data.rejectReason ?? null,
          },
        },
      });
      return next;
    });

    if (transitioned) {
      await enqueueNotification(id, "rejection");
    }

    logger.info(
      { submissionId: id, actor, transitioned },
      "submission rejected",
    );
    return NextResponse.json({ ok: true, submission: updated });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, errMessage: message, submissionId: id },
      "reject failed",
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
