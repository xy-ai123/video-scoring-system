import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@vss/db";
import { logger } from "./logger";

export const SCORING_QUEUE = "scoring";
export const NOTIFICATION_QUEUE = "notifications";

export type ScoreJobPayload = {
  fileId: string;
  submissionId: string;
};

export type NotifyJobPayload = {
  submissionId: string;
  /** Which template to send. Default "approval" for backward-compat. */
  kind?: "approval" | "rejection";
  /** True when an admin manually re-sent the email — worker skips
   *  side-effects (sheet append) it already performed on the first send. */
  resend?: boolean;
};

let _connection: IORedis | undefined;
let _scoringQueue: Queue<ScoreJobPayload> | undefined;
let _notificationQueue: Queue<NotifyJobPayload> | undefined;

function connection(): IORedis {
  if (_connection) return _connection;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  _connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  _connection.on("error", (err) => {
    logger.error({ err }, "redis connection error");
  });
  return _connection;
}

const defaultJobOpts: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 1000, age: 60 * 60 * 24 * 7 },
  removeOnFail: { count: 5000, age: 60 * 60 * 24 * 30 },
};

export function scoringQueue(): Queue<ScoreJobPayload> {
  if (!_scoringQueue) {
    _scoringQueue = new Queue<ScoreJobPayload>(SCORING_QUEUE, {
      connection: connection(),
      defaultJobOptions: defaultJobOpts,
    });
  }
  return _scoringQueue;
}

export function notificationQueue(): Queue<NotifyJobPayload> {
  if (!_notificationQueue) {
    _notificationQueue = new Queue<NotifyJobPayload>(NOTIFICATION_QUEUE, {
      connection: connection(),
      defaultJobOptions: defaultJobOpts,
    });
  }
  return _notificationQueue;
}

/** Enqueue one score-submission job per VideoFile on a submission. */
export async function enqueueScoreJobs(submissionId: string): Promise<number> {
  const files = await prisma.videoFile.findMany({
    where: { submissionId },
    select: { id: true, submissionId: true },
  });
  if (files.length === 0) return 0;
  const q = scoringQueue();
  await q.addBulk(
    files.map((f) => ({
      name: "score-submission",
      data: { fileId: f.id, submissionId: f.submissionId },
      opts: {
        // De-dupe per file. BullMQ disallows ":" in custom job IDs (it uses
        // colons as Redis key separators internally), so we use "-".
        jobId: `score-${f.id}`,
      },
    })),
  );
  return files.length;
}

/** Enqueue a notify-submitter job for an approval or rejection. */
export async function enqueueNotification(
  submissionId: string,
  kind: "approval" | "rejection" = "approval",
): Promise<void> {
  const q = notificationQueue();
  // Distinct jobIds per kind so an APPROVED-then-REJECTED flow doesn't get
  // de-duped against an earlier approval notification.
  await q.add(
    "notify-submitter",
    { submissionId, kind },
    { jobId: `notify-${kind}-${submissionId}` },
  );
}

/** Manually resend the approval email. Uses a timestamped jobId so BullMQ's
 *  de-dup of the original approval job doesn't drop the resend. */
export async function enqueueResendApproval(submissionId: string): Promise<void> {
  const q = notificationQueue();
  await q.add(
    "notify-submitter",
    { submissionId, kind: "approval", resend: true },
    { jobId: `notify-approval-resend-${submissionId}-${Date.now()}` },
  );
}

/** Manually resend the rejection email. Same pattern as approval resend —
 *  timestamped jobId avoids dedup, `resend: true` makes the worker skip the
 *  sheet append that already happened on the original rejection. */
export async function enqueueResendRejection(submissionId: string): Promise<void> {
  const q = notificationQueue();
  await q.add(
    "notify-submitter",
    { submissionId, kind: "rejection", resend: true },
    { jobId: `notify-rejection-resend-${submissionId}-${Date.now()}` },
  );
}
