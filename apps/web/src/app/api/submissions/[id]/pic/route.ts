/**
 * Update the Person-in-Charge name on a submission *without* changing its
 * status. Used by the standalone "Edit PIC" button on the detail page so an
 * admin can record / correct the PIC on an already-decided submission, or
 * fill it in for something that hasn't been approve/rejected yet.
 *
 * The approve/reject API routes still take and persist personInCharge as
 * part of their own flow — this route just covers the "set / change PIC
 * only" case.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  // Empty string is allowed and clears the column (mirrors the notes route).
  // Max length matches the approve/reject route's schema.
  personInCharge: z.string().max(120),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  // Defense-in-depth CSRF check, mirroring the rest of the submission routes.
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

  const id = params.id;
  const actor = admin.user.email;
  const trimmed = parsed.data.personInCharge.trim();
  // Empty → null in the DB so we don't store useless whitespace.
  const nextValue = trimmed.length === 0 ? null : trimmed;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.submission.findUnique({
        where: { id },
        select: { id: true, personInCharge: true },
      });
      if (!current) throw new Error("not_found");
      const next = await tx.submission.update({
        where: { id },
        data: { personInCharge: nextValue },
      });
      await tx.auditLog.create({
        data: {
          actor,
          action: "submission.pic.update",
          target: id,
          payload: {
            previousPersonInCharge: current.personInCharge,
            newPersonInCharge: nextValue,
          },
        },
      });
      return next;
    });

    logger.info(
      { submissionId: id, actor, personInCharge: nextValue },
      "submission PIC updated",
    );
    return NextResponse.json({ ok: true, submission: updated });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, errMessage: message, submissionId: id },
      "PIC update failed",
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
