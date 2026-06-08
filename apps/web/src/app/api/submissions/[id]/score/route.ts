import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/submissions/[id]/score
 *
 * On-demand mock scoring. Replaces the worker + BullMQ queue path for
 * environments where Redis and a scoring worker aren't running
 * (Railway, in this project). Computes deterministic scores from
 * each file's name, writes Score rows + flips the submission to
 * SCORED in a single transaction, and returns the result so the
 * dashboard can router.refresh().
 *
 * Why mock and not the real engine: the real Algorithm Engine
 * (POST multipart/form-data to ALGO_ENGINE_URL) needs a separately-
 * deployed service. The operator picked option C (on-demand button)
 * specifically to avoid that infra cost. Same hash-from-filename
 * algorithm the worker's `mockScores()` uses, so scores stay stable
 * across worker-mode and on-demand-mode for the same file.
 *
 * Skips files that are already COMPLETED so re-clicking the button
 * is idempotent.
 */

/** Hash-from-filename mock — keep this byte-identical to the
 *  worker's mockScores() in apps/worker/src/services/algorithmEngine.ts.
 *  If you ever switch to the real Algorithm Engine, both call sites
 *  must use it; if you stay on mock, both must use this same hash. */
function mockScoresFor(fileName: string): {
  overall: number;
  clarity: number;
  engagement: number;
} {
  const seed = [...fileName].reduce(
    (a, c) => (a * 31 + c.charCodeAt(0)) >>> 0,
    7,
  );
  function r(i: number) {
    return ((seed * (i + 1)) % 1000) / 1000;
  }
  return {
    overall: Number((0.5 + r(1) * 0.5).toFixed(3)),
    clarity: Number((0.4 + r(2) * 0.6).toFixed(3)),
    engagement: Number((0.3 + r(3) * 0.7).toFixed(3)),
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  // CSRF defence — same pattern as /approve.
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

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      files: {
        select: {
          id: true,
          fileName: true,
          driveFileId: true,
          scoringStatus: true,
        },
      },
    },
  });
  if (!submission) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (submission.deletedAt) {
    return NextResponse.json({ error: "deleted" }, { status: 410 });
  }
  // Only score PENDING / SCORING / FAILED. Don't overwrite a row that's
  // already SCORED / APPROVED / REJECTED — those represent operator
  // decisions and scoring would clobber them.
  const scorable = new Set(["PENDING", "SCORING", "FAILED"]);
  if (!scorable.has(submission.status)) {
    return NextResponse.json(
      { error: "not_scorable", currentStatus: submission.status },
      { status: 409 },
    );
  }
  if (submission.files.length === 0) {
    return NextResponse.json({ error: "no_files" }, { status: 400 });
  }

  // Compute mock scores for every file that isn't already COMPLETED.
  // Re-running the endpoint after a partial success is safe — already-
  // scored files are skipped.
  const filesToScore = submission.files.filter(
    (f) => f.scoringStatus !== "COMPLETED",
  );
  if (filesToScore.length === 0) {
    // All files already scored individually but the Submission status
    // somehow wasn't flipped — flip it now and return.
    await prisma.submission.update({
      where: { id: submission.id },
      data: { status: "SCORED" },
    });
    return NextResponse.json({ ok: true, scoredFiles: 0, skipped: submission.files.length });
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const f of filesToScore) {
      const scores = mockScoresFor(f.fileName);
      // Wipe any stale Score rows for this file so re-running the
      // endpoint on a previously-FAILED row gets a clean set, not
      // duplicate metric rows.
      await tx.score.deleteMany({ where: { fileId: f.id } });
      await tx.score.createMany({
        data: Object.entries(scores).map(([metric, value]) => ({
          submissionId: submission.id,
          fileId: f.id,
          metric,
          value,
        })),
      });
      await tx.videoFile.update({
        where: { id: f.id },
        data: {
          scoringStatus: "COMPLETED",
          scoringError: null,
          processedAt: now,
        },
      });
    }
    await tx.submission.update({
      where: { id: submission.id },
      data: { status: "SCORED" },
    });
    await tx.auditLog.create({
      data: {
        actor: admin.user.email,
        action: "submission.score.on_demand",
        target: submission.id,
        payload: {
          fileIds: filesToScore.map((f) => f.id),
          fileNames: filesToScore.map((f) => f.fileName),
          source: "mock_engine",
        },
      },
    });
  });

  return NextResponse.json({
    ok: true,
    scoredFiles: filesToScore.length,
    skipped: submission.files.length - filesToScore.length,
  });
}
