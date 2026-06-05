import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  // Allow clearing the notes by sending an empty string, but cap the length.
  notes: z.string().max(2000),
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
  const newNotes = parsed.data.notes.trim();

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.submission.findUnique({ where: { id } });
      if (!current) throw new Error("not_found");

      const next = await tx.submission.update({
        where: { id },
        data: {
          // Empty string -> null in the DB so we don't store useless whitespace.
          notes: newNotes.length === 0 ? null : newNotes,
        },
      });
      await tx.auditLog.create({
        data: {
          actor,
          action: "submission.notes.update",
          target: id,
          payload: {
            previousNotes: current.notes,
            newNotes: newNotes.length === 0 ? null : newNotes,
          },
        },
      });
      return next;
    });

    logger.info({ submissionId: id, actor }, "submission notes updated");
    return NextResponse.json({ ok: true, submission: updated });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, errMessage: message, submissionId: id },
      "notes update failed",
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
