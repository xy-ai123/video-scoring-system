/**
 * Update the Category on a single submission *without* changing its
 * status or any other field. Used by the dashboard's inline click-to-edit
 * category cell so operators can manually categorise Drive-ingested
 * submissions (which now start with a blank category).
 *
 * Mirrors the per-row /api/submissions/[id]/pic route — empty string is
 * allowed and clears the column. Soft-deleted rows are rejected with
 * 404 so the trash flow's restore-first behaviour stays consistent.
 *
 * The bulk-category endpoint still requires a non-empty value (you don't
 * usually want to bulk-blank); per-row edits are more granular and want
 * the option to clear.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  // Empty string is allowed and clears the column (mirrors PIC + notes).
  category: z.string().max(100),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  // Defense-in-depth CSRF check, mirroring the other submission routes.
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
  const nextValue = parsed.data.category.trim();

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.submission.findUnique({
        where: { id },
        select: { id: true, category: true, deletedAt: true },
      });
      if (!current) throw new Error("not_found");
      if (current.deletedAt) throw new Error("deleted");
      if (current.category === nextValue) {
        // No change — return existing row, skip the audit row to keep
        // the log tidy on accidental double-saves.
        return await tx.submission.findUnique({ where: { id } });
      }
      const next = await tx.submission.update({
        where: { id },
        data: { category: nextValue },
      });
      await tx.auditLog.create({
        data: {
          actor,
          action: "submission.category.update",
          target: id,
          payload: {
            previousCategory: current.category,
            newCategory: nextValue,
          },
        },
      });
      return next;
    });

    logger.info(
      { submissionId: id, actor, category: nextValue },
      "submission category updated",
    );
    return NextResponse.json({ ok: true, submission: updated });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (err instanceof Error && err.message === "deleted") {
      return NextResponse.json(
        { error: "submission is deleted; restore it first" },
        { status: 409 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, errMessage: message, submissionId: id },
      "category update failed",
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
