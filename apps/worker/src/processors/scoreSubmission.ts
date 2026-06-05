import type { Job } from "bullmq";
import { prisma } from "@vss/db";
import { downloadFile } from "../services/drive.js";
import { scoreVideo } from "../services/algorithmEngine.js";
import { logger } from "../lib/logger.js";
import type { ScoreJobPayload } from "../lib/queue.js";

export async function processScoreSubmission(
  job: Job<ScoreJobPayload>,
): Promise<{ scored: number }> {
  const { fileId, submissionId } = job.data;
  const log = logger.child({ jobId: job.id, fileId, submissionId });

  // 1. Load file. Skip if already completed (idempotency on retry).
  const file = await prisma.videoFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      submissionId: true,
      driveFileId: true,
      fileName: true,
      mimeType: true,
      scoringStatus: true,
    },
  });
  if (!file) {
    log.warn("file not found, dropping job");
    return { scored: 0 };
  }
  if (file.scoringStatus === "COMPLETED") {
    log.info("file already scored, skipping");
    return { scored: 0 };
  }

  // 2. Mark IN_PROGRESS and bump submission to SCORING (idempotent updates).
  await prisma.$transaction([
    prisma.videoFile.update({
      where: { id: file.id },
      data: { scoringStatus: "IN_PROGRESS", scoringError: null },
    }),
    prisma.submission.updateMany({
      where: { id: file.submissionId, status: "PENDING" },
      data: { status: "SCORING" },
    }),
  ]);

  try {
    // 3. Download metadata once (also serves as a Drive auth check).
    const initial = await downloadFile(file.driveFileId);
    log.debug(
      { mimeType: initial.mimeType, size: initial.size },
      "downloaded from drive",
    );

    // 4. Score via Algorithm Engine. We pass a stream FACTORY so that each
    //    inner retry inside scoreVideo gets a fresh Drive stream (Node streams
    //    are single-use). The first call returns the stream we already opened;
    //    subsequent calls re-download.
    let usedInitial = false;
    const { scores, raw } = await scoreVideo({
      streamFactory: async () => {
        if (!usedInitial) {
          usedInitial = true;
          return initial.stream;
        }
        const fresh = await downloadFile(file.driveFileId);
        return fresh.stream;
      },
      fileName: file.fileName,
      mimeType: initial.mimeType,
      knownLength: initial.size,
    });
    const dl = initial;
    const scoreEntries = Object.entries(scores);
    log.info({ metrics: scoreEntries.length }, "engine returned scores");

    // 5. Persist scores + size + completion in a single transaction.
    await prisma.$transaction(async (tx) => {
      await tx.score.createMany({
        data: scoreEntries.map(([metric, value]) => ({
          submissionId: file.submissionId,
          fileId: file.id,
          metric,
          value,
          raw: raw as object,
        })),
      });

      await tx.videoFile.update({
        where: { id: file.id },
        data: {
          scoringStatus: "COMPLETED",
          processedAt: new Date(),
          sizeBytes: dl.size != null ? BigInt(dl.size) : undefined,
          mimeType: dl.mimeType,
          // Persist duration when Drive metadata exposed it. Use `undefined`
          // (not null) on miss so we don't clobber a previously-recorded
          // duration on a retry.
          durationSec: dl.durationSec ?? undefined,
        },
      });

      // If every file in the submission is COMPLETED, transition to SCORED.
      const remaining = await tx.videoFile.count({
        where: {
          submissionId: file.submissionId,
          scoringStatus: { not: "COMPLETED" },
        },
      });
      if (remaining === 0) {
        await tx.submission.updateMany({
          where: {
            id: file.submissionId,
            status: { in: ["PENDING", "SCORING"] },
          },
          data: { status: "SCORED" },
        });
      }
    });

    return { scored: scoreEntries.length };
  } catch (err) {
    const isFinalAttempt =
      job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, isFinalAttempt }, "scoring failed");

    await prisma.videoFile.update({
      where: { id: file.id },
      data: {
        scoringStatus: isFinalAttempt ? "FAILED" : "PENDING",
        scoringError: message.slice(0, 500),
      },
    });

    if (isFinalAttempt) {
      // Mark submission FAILED only if all files are FAILED; otherwise leave it.
      const remainingNotFailed = await prisma.videoFile.count({
        where: {
          submissionId: file.submissionId,
          scoringStatus: { notIn: ["FAILED"] },
        },
      });
      if (remainingNotFailed === 0) {
        await prisma.submission.updateMany({
          where: {
            id: file.submissionId,
            status: { in: ["PENDING", "SCORING"] },
          },
          data: { status: "FAILED" },
        });
      }
    }
    throw err; // BullMQ handles retry vs final failure recording.
  }
}
