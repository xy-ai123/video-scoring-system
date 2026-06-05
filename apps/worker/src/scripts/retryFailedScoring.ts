/**
 * One-off: re-enqueue scoring for every VideoFile that's currently in
 * `scoringStatus = FAILED`. The job processor itself is unchanged — we just
 * reset the file's status / error and put a fresh job on the queue. If the
 * original transient error has cleared up (e.g. a Drive blip), the retry
 * will succeed and the file lands in COMPLETED.
 *
 * Submission status handling:
 *  - If the submission's status is FAILED, we reset it to PENDING so the
 *    scoring processor's normal PENDING → SCORING → SCORED transitions
 *    apply on the retry.
 *  - Otherwise (REJECTED, APPROVED, SCORED, …) we leave the submission
 *    status alone. An admin's manual decision is preserved; only the
 *    per-file scoring error indicator on the detail page goes away.
 *
 * Usage (from apps/worker):
 *   pnpm exec tsx src/scripts/retryFailedScoring.ts
 */

// Same dotenv bootstrap as backfillDurations.ts — Prisma/env need DATABASE_URL.
import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: "../../.env", override: false });

import { prisma } from "@vss/db";
import { scoringQueue } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

async function main() {
  const failed = await prisma.videoFile.findMany({
    where: {
      scoringStatus: "FAILED",
      submission: { deletedAt: null },
    },
    select: {
      id: true,
      submissionId: true,
      fileName: true,
      scoringError: true,
      submission: { select: { id: true, status: true, submitterEmail: true } },
    },
  });

  logger.info({ count: failed.length }, "retryFailedScoring: starting");
  if (failed.length === 0) {
    await prisma.$disconnect();
    return;
  }

  // Group by submission so we can reset the submission-level status once.
  const bySubmission = new Map<
    string,
    { submissionStatus: string; fileIds: string[] }
  >();
  for (const f of failed) {
    const entry = bySubmission.get(f.submissionId);
    if (entry) {
      entry.fileIds.push(f.id);
    } else {
      bySubmission.set(f.submissionId, {
        submissionStatus: f.submission.status,
        fileIds: [f.id],
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const [submissionId, { submissionStatus, fileIds }] of bySubmission) {
      await tx.videoFile.updateMany({
        where: { id: { in: fileIds } },
        data: { scoringStatus: "PENDING", scoringError: null },
      });
      if (submissionStatus === "FAILED") {
        await tx.submission.update({
          where: { id: submissionId },
          data: { status: "PENDING" },
        });
      }
      await tx.auditLog.create({
        data: {
          actor: "retryFailedScoring.ts",
          action: "submission.scoring.retry",
          target: submissionId,
          payload: {
            previousSubmissionStatus: submissionStatus,
            fileIdsReset: fileIds,
          },
        },
      });
    }
  });

  // Enqueue jobs with a unique jobId so BullMQ won't dedupe against the
  // previously-failed `score-${fileId}` job that still lives in the failed
  // set. The scoring processor doesn't care about the job name/id.
  const q = scoringQueue();
  const stamp = Date.now();
  const jobs = failed.map((f) => ({
    name: "score-submission",
    data: { fileId: f.id, submissionId: f.submissionId },
    opts: { jobId: `score-retry-${f.id}-${stamp}` as string },
  }));
  await q.addBulk(jobs);

  logger.info(
    {
      enqueued: jobs.length,
      submissions: bySubmission.size,
    },
    "retryFailedScoring: jobs enqueued",
  );

  // Important: close the BullMQ queue + Redis connection so the script can
  // exit cleanly. Without this, the underlying ioredis connection keeps the
  // event loop alive forever.
  await q.close();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  logger.error({ err }, "retryFailedScoring: fatal");
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
