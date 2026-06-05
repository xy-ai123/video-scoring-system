import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { enqueueResendApproval } from "@/lib/queue";
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
    if (submission.status !== "APPROVED") {
      return NextResponse.json(
        { error: "submission is not approved; resend is only available for APPROVED submissions" },
        { status: 409 },
      );
    }

    await prisma.auditLog.create({
      data: {
        actor,
        action: "submission.approval.resend",
        target: id,
        payload: { status: submission.status },
      },
    });

    await enqueueResendApproval(id);

    logger.info({ submissionId: id, actor }, "approval email resend enqueued");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, errMessage: message, submissionId: id },
      "resend-approval failed",
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
