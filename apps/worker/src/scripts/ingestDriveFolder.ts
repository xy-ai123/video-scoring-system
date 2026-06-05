/**
 * Run the Drive-folder ingestion either as a one-shot or as a poll loop.
 *
 * One-shot (default): scan the folder once, ingest new uploads, exit.
 *
 *   pnpm exec tsx src/scripts/ingestDriveFolder.ts
 *
 * Watch mode: keep polling forever at a fixed interval. Use this if you want
 * a Drive upload to appear in /admin without anyone having to run a script.
 *
 *   pnpm exec tsx src/scripts/ingestDriveFolder.ts --watch
 *   pnpm exec tsx src/scripts/ingestDriveFolder.ts --watch --interval=30
 *
 * Folder is the form's "Video (File responses)" folder by default; override
 * with --folder=<id> or env DRIVE_INGEST_FOLDER_ID.
 */

import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: "../../.env", override: false });

import { prisma } from "@vss/db";
import {
  ingestFromDriveFolder,
  DEFAULT_DRIVE_INGEST_FOLDER_ID,
} from "../services/driveFolderIngest.js";
import { scoringQueue } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

type Args = {
  folderId: string;
  watch: boolean;
  intervalSec: number;
};

function parseArgs(argv: string[]): Args {
  let folderId =
    process.env.DRIVE_INGEST_FOLDER_ID ?? DEFAULT_DRIVE_INGEST_FOLDER_ID;
  let watch = false;
  let intervalSec = 60;
  for (const a of argv) {
    if (a === "--watch") watch = true;
    const folderMatch = a.match(/^--folder=(.+)$/);
    if (folderMatch && folderMatch[1]) folderId = folderMatch[1];
    const intervalMatch = a.match(/^--interval=(\d+)$/);
    if (intervalMatch && intervalMatch[1]) {
      intervalSec = Math.max(5, Math.min(3600, Number(intervalMatch[1])));
    }
  }
  return { folderId, watch, intervalSec };
}

async function runOnce(folderId: string) {
  const summary = await ingestFromDriveFolder(folderId);
  logger.info(summary, "ingestDriveFolder: tick complete");
  return summary;
}

async function main() {
  const { folderId, watch, intervalSec } = parseArgs(process.argv.slice(2));
  logger.info({ folderId, watch, intervalSec }, "ingestDriveFolder: starting");

  if (!watch) {
    await runOnce(folderId);
    // Drain the BullMQ queue + Postgres pool so the script exits cleanly.
    await scoringQueue().close();
    await prisma.$disconnect();
    return;
  }

  // Watch mode: loop indefinitely. Per-tick failures get logged and don't
  // crash the loop, since transient Drive 503s shouldn't break ingestion.
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.info({ sig }, "ingestDriveFolder: shutting down");
      stopping = true;
    });
  }

  while (!stopping) {
    try {
      await runOnce(folderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ errMessage: message }, "ingestDriveFolder: tick failed");
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }

  await scoringQueue().close();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  logger.error({ err }, "ingestDriveFolder: fatal");
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
