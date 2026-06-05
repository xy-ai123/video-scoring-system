import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { enqueueResendRejection } from "@/lib/queue";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
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
    const submission = await prisma.submission.findUnique({
      where: { id },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!submission) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (submission.deletedAt) {
      return NextResponse.json(
        { error: "submission is deleted; restore before resending" },
        { status: 409 },
      );
    }
    if (submission.status !== "REJECTED") {
      return NextResponse.json(
        { error: "submission is not rejected; resend is only available for REJECTED submissions" },
        { status: 409 },
      );
    }

    await prisma.auditLog.create({
      data: {
        actor,
        action: "submission.rejection.resend",
        target: id,
        payload: { status: submission.status },
      },
    });

    await enqueueResendRejection(id);

    logger.info({ submissionId: id, actor }, "rejection email resend enqueued");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, errMessage: message, submissionId: id },
      "resend-rejection failed",
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
