// Load .env into process.env BEFORE anything else runs. Without this,
// process.env only has whatever the parent shell exported, which is why a
// freshly-added env var (e.g. GMAIL_SMTP_PASSWORD) silently looks empty even
// though it's in the .env file on disk.
//
// dotenv reads from cwd; when launched via `pnpm dev:worker` the cwd is
// `apps/worker/`, so this picks up apps/worker/.env. We also list the project
// root .env as a secondary source so values defined only there are still
// honored.
import { config as loadDotenv } from "dotenv";
loadDotenv(); // apps/worker/.env (cwd default)
loadDotenv({ path: "../../.env", override: false }); // project-root .env

import { Worker, type WorkerOptions } from "bullmq";
import {
  redisConnection,
  SCORING_QUEUE,
  NOTIFICATION_QUEUE,
  type ScoreJobPayload,
  type NotifyJobPayload,
} from "./lib/queue.js";
import { logger } from "./lib/logger.js";
import { getEnv, env } from "./lib/env.js";
import { listSheetTabs } from "./services/sheets.js";
import { processScoreSubmission } from "./processors/scoreSubmission.js";
import { processNotifySubmitter } from "./processors/notifySubmitter.js";

// Eagerly validate env on boot.
getEnv();

// One-shot diagnostic: if SHEET_ID is configured, log all available tabs in
// that spreadsheet. Lets the operator copy the right value into SHEET_TAB
// without leaving the terminal. Failures are non-fatal — we just log.
if (env.SHEET_ID) {
  void listSheetTabs()
    .then((tabs) => {
      logger.info(
        {
          sheetId: env.SHEET_ID,
          tabs,
          activeSheetTab: env.SHEET_TAB || "(unset — defaults to first tab)",
        },
        "sheet tabs available",
      );
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          errMessage: message,
          hint: "Verify the sheet is shared with the service account as Editor and that Sheets API is enabled.",
        },
        "could not list sheet tabs",
      );
    });
}

const baseOpts: WorkerOptions = {
  connection: redisConnection(),
  concurrency: 4,
};

const scoringWorker = new Worker<ScoreJobPayload>(
  SCORING_QUEUE,
  async (job) => processScoreSubmission(job),
  baseOpts,
);

const notificationWorker = new Worker<NotifyJobPayload>(
  NOTIFICATION_QUEUE,
  async (job) => processNotifySubmitter(job),
  { ...baseOpts, concurrency: 2 },
);

scoringWorker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, queue: SCORING_QUEUE, result }, "job completed");
});
scoringWorker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, queue: SCORING_QUEUE, err: err?.message },
    "job failed",
  );
});
scoringWorker.on("error", (err) => {
  logger.error({ err, queue: SCORING_QUEUE }, "worker error");
});

notificationWorker.on("completed", (job) => {
  logger.info(
    { jobId: job.id, queue: NOTIFICATION_QUEUE },
    "notification sent",
  );
});
notificationWorker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, queue: NOTIFICATION_QUEUE, err: err?.message },
    "notification failed",
  );
});
notificationWorker.on("error", (err) => {
  logger.error({ err, queue: NOTIFICATION_QUEUE }, "worker error");
});

logger.info("worker started");

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down...");
  try {
    await Promise.allSettled([
      scoringWorker.close(),
      notificationWorker.close(),
    ]);
  } catch (err) {
    logger.error({ err }, "error during shutdown");
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException");
});
