/**
 * Sync the dashboard with everything currently shared with the worker's
 * service account: raw video files (via the regular driveFolderIngest) and
 * videos packaged inside ZIP archives (via zipIngest).
 *
 * Designed to be safe to run repeatedly — both ingest paths are idempotent.
 *
 *   # one-shot
 *   pnpm exec tsx src/scripts/syncFromSharedDrive.ts
 *
 *   # poll forever (default interval = 60s)
 *   pnpm exec tsx src/scripts/syncFromSharedDrive.ts --watch
 *   pnpm exec tsx src/scripts/syncFromSharedDrive.ts --watch --interval=120
 *
 * Doesn't touch the existing watcher or change any other ingest behavior;
 * this is purely additive. The original ingestDriveFolder watcher (which
 * only picks up raw video files in the form-responses folder) keeps running
 * unchanged — this script adds coverage for every shared folder plus ZIPs.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: "../../.env", override: false });

import { prisma } from "@vss/db";
import { getDriveClient } from "../services/drive.js";
import {
  ingestFolderFast,
  ingestFromDriveFolder,
  softDeleteMissingDriveSubmissions,
} from "../services/driveFolderIngest.js";
import { ingestZipsFromSharedDrives } from "../services/zipIngest.js";
import { scoringQueue } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

async function listAllSharedFolders(): Promise<{ id: string; name: string }[]> {
  const drive = getDriveClient();
  const out: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `mimeType = '${FOLDER_MIME}' and trashed = false`,
      pageSize: 1000,
      fields: "nextPageToken, files(id, name)",
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) out.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

function parseArgs(argv: string[]): { watch: boolean; intervalSec: number } {
  let watch = false;
  let intervalSec = 60;
  for (const a of argv) {
    if (a === "--watch") watch = true;
    const m = a.match(/^--interval=(\d+)$/);
    if (m && m[1]) {
      intervalSec = Math.max(15, Math.min(3600, Number(m[1])));
    }
  }
  return { watch, intervalSec };
}

async function runOnce() {
  // 1. Raw video files — uses the existing battle-tested ingester per folder.
  const folders = await listAllSharedFolders();
  logger.info({ count: folders.length }, "syncFromSharedDrive: folders");

  const rawTotals = {
    foldersWalked: 0,
    scanned: 0,
    ingested: 0,
    durationsBackfilled: 0,
    softDeleted: 0,
    errors: 0,
  };
  // Aggregate every drive file ID seen across the whole sweep so the
  // soft-delete pass at the end has the *complete* "what's currently in
  // Drive" set. Soft-deleting per folder would incorrectly trash files
  // that live in another folder we just haven't scanned yet (the bug
  // that wiped 9 newly-uploaded VPM0166/VPM0167 videos before this fix).
  const unionDriveFileIds = new Set<string>();

  // ─── PHASE 1: fast pass ────────────────────────────────────────────────
  // Insert new VideoFile rows + mirror Drive-side renames/mime/size + sync
  // folder-name drift. Skips the slow stuff (duration measurement, sheet
  // sync). Goal: every dashboard-visible state change (new file, rename,
  // folder rename, new main folder discovered) lands within ~30-45s,
  // safely under Railway's 60s subprocess timeout.
  // ───────────────────────────────────────────────────────────────────────
  let phase1Renamed = 0;
  let phase1CategoriesUpdated = 0;
  for (const folder of folders) {
    try {
      const s = await ingestFolderFast(folder.id);
      rawTotals.foldersWalked += 1;
      rawTotals.scanned += s.scanned;
      rawTotals.ingested += s.ingested;
      rawTotals.errors += s.errors;
      phase1Renamed += s.renamed;
      phase1CategoriesUpdated += s.categoriesUpdated;
      for (const id of s.driveFileIds) unionDriveFileIds.add(id);
    } catch (err) {
      rawTotals.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { folder: folder.name, folderId: folder.id, errMessage: message },
        "syncFromSharedDrive: phase-1 ingest error",
      );
    }
  }
  // Soft-delete pass uses the union of every folder's current IDs, so
  // it's safe to run after phase 1 even though phase 2 hasn't started.
  // (Soft-delete only looks at "is this file's id present in the union?",
  // it doesn't depend on duration / sheet sync.)
  try {
    rawTotals.softDeleted = await softDeleteMissingDriveSubmissions(
      unionDriveFileIds,
      logger,
    );
  } catch (err) {
    rawTotals.errors += 1;
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { errMessage: message },
      "syncFromSharedDrive: aggregated soft-delete failed",
    );
  }
  logger.info(
    {
      ...rawTotals,
      phase1Renamed,
      phase1CategoriesUpdated,
    },
    "syncFromSharedDrive: phase 1 (fast) done",
  );

  // ─── PHASE 2: slow tail ────────────────────────────────────────────────
  // Backfill `durationSec` for rows still missing it + run sheet sync.
  // May get SIGTERM'd by Railway before completing; that's acceptable —
  // the next sync tick picks up where this one left off (both operations
  // are idempotent and bounded by their own "needs work?" predicates).
  // Phase 1 already handled every user-visible state change, so a
  // mid-folder kill here is invisible to operators.
  // ───────────────────────────────────────────────────────────────────────
  for (const folder of folders) {
    try {
      const s = await ingestFromDriveFolder(folder.id, {
        skipSoftDelete: true,
      });
      rawTotals.durationsBackfilled += s.durationsBackfilled;
    } catch (err) {
      rawTotals.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { folder: folder.name, folderId: folder.id, errMessage: message },
        "syncFromSharedDrive: phase-2 backfill error",
      );
    }
  }
  logger.info(rawTotals, "syncFromSharedDrive: raw videos done");

  // 2. ZIP archives — extracts video entries and creates one Submission per
  //    extracted video.
  const zipSummary = await ingestZipsFromSharedDrives();
  logger.info(zipSummary, "syncFromSharedDrive: zip ingest done");

  return { rawTotals, zipSummary };
}

/**
 * Close transient connections + force the process to exit. The
 * scoring queue keeps an ioredis connection with a retry timer that
 * holds the Node event loop open even after queue.close() returns,
 * which blocks the subprocess from exiting on Railway (no Redis →
 * connection forever pending). The web app's spawn wrapper marks the
 * sync as finished only when the subprocess exits, so without this
 * force-exit the "Syncing Drive…" button gets stuck visible.
 *
 * Best-effort close first so any in-flight Redis traffic flushes,
 * then process.exit so the OS kernel reclaims the socket.
 */
async function shutdown(exitCode: number): Promise<never> {
  try {
    // Race the queue close against a short deadline so a broken
    // connection can't keep us hanging.
    await Promise.race([
      scoringQueue().close(),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // ignore — we're about to exit anyway
  }
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(exitCode);
}

async function main() {
  const { watch, intervalSec } = parseArgs(process.argv.slice(2));
  logger.info({ watch, intervalSec }, "syncFromSharedDrive: starting");

  if (!watch) {
    const result = await runOnce();
    logger.info(result, "syncFromSharedDrive: complete");
    await shutdown(0);
    return;
  }

  // Watch mode: keep polling forever. Per-tick failures get logged and
  // don't crash the loop, so a transient Drive 503 doesn't break ingestion.
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.info({ sig }, "syncFromSharedDrive: shutting down");
      stopping = true;
    });
  }
  while (!stopping) {
    try {
      const result = await runOnce();
      logger.info(result, "syncFromSharedDrive: tick complete");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ errMessage: message }, "syncFromSharedDrive: tick failed");
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
  await shutdown(0);
}

main().catch(async (err) => {
  logger.error({ err }, "syncFromSharedDrive: fatal");
  await shutdown(1);
});
