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
    // `null` was originally chosen to match BullMQ workers' need to wait
    // out a transient Redis outage forever. That's correct for the
    // long-running worker process — but when the WEB app spawns a
    // one-shot sync script (syncFromSharedDrive) in an environment
    // without Redis (Railway, where the placeholder REDIS_URL points
    // at a non-existent localhost), the unbounded retry meant every
    // scoringQueue.addBulk() call hung indefinitely and the subprocess
    // never exited — the dashboard "Syncing Drive…" button got stuck
    // visible until a Railway redeploy. Limit retries-per-command so
    // attempts fail fast (~5-10s total) when there's no Redis. Real
    // worker uptime is unaffected because the retry budget refreshes
    // per command — only catastrophic outages get capped.
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    // Cap the initial-connect retry storm too: only N attempts before
    // we surface the error to callers (who can try/catch it).
    connectTimeout: 3000,
    retryStrategy(times: number): number | null {
      if (times > 3) return null; // give up
      return Math.min(times * 200, 1000);
    },
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
