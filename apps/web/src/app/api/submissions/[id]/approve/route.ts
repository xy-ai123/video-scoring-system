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
  // Free-text "Person in Charge" name typed by the admin in the
  // approve/reject dialog. Optional so we don't break older clients, but the
  // UI requires it before letting the admin submit.
  personInCharge: z.string().min(1).max(120).optional(),
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

  try {
    // Track whether we actually transitioned status this call. We only
    // re-enqueue the email when the status moved INTO APPROVED (any -> APPROVED).
    // Notes-only re-saves on an already-APPROVED submission don't trigger
    // another email — the operator can use POST /api/submissions/:id/notes
    // for that, but we also handle the idempotent path here cleanly.
    let transitioned = false;
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.submission.findUnique({ where: { id } });
      if (!current) throw new Error("not_found");

      const wasAlreadyApproved = current.status === "APPROVED";
      transitioned = !wasAlreadyApproved;

      const next = await tx.submission.update({
        where: { id },
        data: {
          status: "APPROVED",
          // Preserve original review timestamp when only flipping notes on an
          // already-APPROVED submission. Otherwise stamp the new decision time.
          reviewedAt: wasAlreadyApproved
            ? (current.reviewedAt ?? new Date())
            : new Date(),
          reviewedBy: actor,
          notes: parsed.data.notes ?? current.notes,
          // Only overwrite Person in Charge when one is supplied. Re-saving
          // notes on an already-approved submission without re-entering a
          // name shouldn't blank out the existing PIC.
          ...(parsed.data.personInCharge != null
            ? { personInCharge: parsed.data.personInCharge.trim() }
            : {}),
          // Flipping a rejected row back to approved should clear the old
          // reject reason — a stale rejection rationale on an approved
          // submission is confusing.
          ...(current.status === "REJECTED" ? { rejectReason: null } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          actor,
          action: wasAlreadyApproved
            ? "submission.approve.update"
            : current.status === "REJECTED"
              ? "submission.approve.from_rejected"
              : "submission.approve",
          target: id,
          payload: {
            previousStatus: current.status,
            notes: parsed.data.notes ?? null,
            personInCharge: parsed.data.personInCharge ?? null,
          },
        },
      });
      return next;
    });

    if (transitioned) {
      await enqueueNotification(id, "approval");
    }

    logger.info(
      { submissionId: id, actor, transitioned },
      "submission approved",
    );
    return NextResponse.json({ ok: true, submission: updated });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const message =
      err instanceof Error ? err.message : String(err);
    logger.error(
      { err, errMessage: message, submissionId: id },
      "approve failed",
    );
    // In dev, surface the actual cause so we don't have to dig through stack traces.
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
