import IORedis from "ioredis";
import { Queue, type JobsOptions } from "bullmq";
import { env } from "./env.js";
import { logger } from "./logger.js";

export const SCORING_QUEUE = "scoring";
export const NOTIFICATION_QUEUE = "notifications";

export type ScoreJobPayload = {
  fileId: string;
  submissionId: string;
};

export type NotifyJobPayload = {
  submissionId: string;
  /** "approval" or "rejection". Default "approval" for backward-compat. */
  kind?: "approval" | "rejection";
  /** True for admin-triggered resends — worker skips side-effects (sheet
   *  append) already performed on the original send. */
  resend?: boolean;
};

let _connection: IORedis | undefined;

export function redisConnection(): IORedis {
  if (_connection) return _connection;
  _connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  _connection.on("error", (err) => logger.error({ err }, "redis error"));
  return _connection;
}

const defaultJobOpts: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 1000, age: 60 * 60 * 24 * 7 },
  removeOnFail: { count: 5000, age: 60 * 60 * 24 * 30 },
};

let _scoringQueue: Queue<ScoreJobPayload> | undefined;
let _notificationQueue: Queue<NotifyJobPayload> | undefined;

export function scoringQueue(): Queue<ScoreJobPayload> {
  if (!_scoringQueue) {
    _scoringQueue = new Queue<ScoreJobPayload>(SCORING_QUEUE, {
      connection: redisConnection(),
      defaultJobOptions: defaultJobOpts,
    });
  }
  return _scoringQueue;
}

export function notificationQueue(): Queue<NotifyJobPayload> {
  if (!_notificationQueue) {
    _notificationQueue = new Queue<NotifyJobPayload>(NOTIFICATION_QUEUE, {
      connection: redisConnection(),
      defaultJobOptions: defaultJobOpts,
    });
  }
  return _notificationQueue;
}
