/**
 * Drive-folder ingestion.
 *
 * Lists every video file in a Drive folder and creates a Submission +
 * VideoFile for each one that isn't already in our DB, then enqueues
 * scoring so the new files flow through the same pipeline as Google-Form
 * submissions. Idempotent: re-running picks up only files added since the
 * last call.
 *
 * Use case: someone uploads a video directly to the form's "Video (File
 * responses)" Drive folder (or any folder configured below) — without going
 * through Google Forms — and we still want it scored and surfaced in /admin.
 */

import { prisma } from "@vss/db";
import { getDriveClient } from "./drive.js";
import { scoringQueue } from "../lib/queue.js";
import { logger } from "../lib/logger.js";
import { measureDriveVideoDuration } from "./videoDuration.js";
import { appendDecisionRow, averageMetric } from "./sheets.js";
import { env } from "../lib/env.js";

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Default folder ID. This is the Google Form's auto-created upload folder
 * "Video (File responses)" — confirmed via drive.files.list. Overridable
 * per-call (or via the script's --folder= / DRIVE_INGEST_FOLDER_ID env).
 */
export const DEFAULT_DRIVE_INGEST_FOLDER_ID =
  "1slwoOq2d02o4XbHuO9ab4IM7yDeZEo1FjICtiA8hQlzbA70Krz4KM7jtR0IRptww2aEBAWNy";

// q-clause that matches everything Drive considers a video. The Google Drive
// "video" native mimeType is rare but exists; we include it for completeness.
const VIDEO_MIME_Q =
  "(mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.video')";

export type IngestSummary = {
  folderId: string;
  /** Total video files seen, across the root folder and any subfolders. */
  scanned: number;
  /** Folders walked (including the root). 1 means no subfolders were found. */
  foldersWalked: number;
  alreadyKnown: number;
  ingested: number;
  /** Rows that already existed in the DB but had `durationSec = null` and
   *  whose duration we filled in during this run. Bookkeeping so the user
   *  can tell whether the watcher is making forward progress. */
  durationsBackfilled: number;
  /** VideoFile rows whose Drive-side metadata (fileName, mimeType, or
   *  sizeBytes) drifted since the last sync and was mirrored back in. The
   *  field keeps its historical "renamed" name for back-compat with
   *  callers; rename is the common-case trigger. */
  renamed: number;
  /** Drive-ingested submissions whose `category` we updated because the
   *  file's immediate parent folder changed name OR the row was created
   *  before the parent-folder-as-category behaviour shipped. */
  categoriesUpdated: number;
  /** Drive-ingested submissions that we appended a row for in the Score
   *  Record Google Sheet this tick. The existing form/webhook path writes
   *  rows on approve/reject; this number covers drive-ingested ones that
   *  are SCORED but not yet decided. */
  sheetRowsLogged: number;
  /** Drive-ingested submissions (responseId starts with "drive-") that we
   *  soft-deleted this tick because their Drive file is no longer present
   *  anywhere in the scanned folder tree. */
  softDeleted: number;
  errors: number;
  /** IDs of submissions created in this run, in insertion order. */
  newSubmissionIds: string[];
  /** Every Drive file ID seen in this folder's tree this tick. Exposed
   *  so multi-folder callers (syncFromSharedDrive) can union them across
   *  every shared folder and run one aggregated soft-delete pass at the
   *  end — running soft-delete per-folder would incorrectly soft-delete
   *  files that live in OTHER folders. */
  driveFileIds: string[];
};

type DriveVideoFile = {
  id: string;
  name: string;
  mimeType: string | null;
  size: string | null;
  createdTime: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  /** ID of the immediate Drive folder this video sits in. For files in the
   *  root the value is the root folderId we were asked to ingest. */
  parentFolderId: string;
  /** Display name of the immediate parent folder — what we surface as the
   *  submission's `category` column on the dashboard. */
  parentFolderName: string;
};

// Tighten the response shape so TS doesn't trip over inferring the generic
// returned by `drive.files.list` when we mutate `pageToken` across loop
// iterations. We only ever read these two fields.
type ListResponse = {
  data: {
    files?: Array<{
      id?: string | null;
      name?: string | null;
      mimeType?: string | null;
      size?: string | null;
      createdTime?: string | null;
      owners?: Array<{
        emailAddress?: string | null;
        displayName?: string | null;
      }>;
    }>;
    nextPageToken?: string | null;
  };
};

/**
 * Walk a folder tree (root + all subfolders) and return every video file
 * found in any level. Folders are discovered as we go via a worklist; a
 * visited-set prevents infinite loops even though Drive's data model
 * shouldn't allow them.
 *
 * Returns the list of video files plus how many folders we walked, so the
 * summary can show "scanned 17 files across 3 folders".
 */
async function listVideosRecursively(rootFolderId: string): Promise<{
  files: DriveVideoFile[];
  foldersWalked: number;
}> {
  const drive = getDriveClient();
  const queue: string[] = [rootFolderId];
  const visited = new Set<string>();
  const files: DriveVideoFile[] = [];
  // folderId → human display name. Populated as we walk; used to tag each
  // video file with its immediate parent's name so the ingester can use it
  // as the submission's category.
  const folderNames = new Map<string, string>();

  // Files dropped directly in the root folder need a parent label too —
  // use the root folder's *actual* Drive display name (e.g. "VPM0166",
  // "15 May") rather than a hardcoded placeholder. The original watcher
  // only swept one well-known root ("Video (File responses)") so a
  // literal label was fine; now that syncFromSharedDrive sweeps every
  // shared folder, each root's own name is what operators actually want
  // to see on the dashboard.
  try {
    const rootMeta = await drive.files.get({
      fileId: rootFolderId,
      fields: "id,name",
      supportsAllDrives: true,
    });
    folderNames.set(rootFolderId, rootMeta.data.name ?? "Drive");
  } catch {
    // Permission / 404 — fall back to a generic placeholder so we still
    // produce a non-empty parentFolderName.
    folderNames.set(rootFolderId, "Drive");
  }

  while (queue.length > 0) {
    const folderId = queue.shift()!;
    if (visited.has(folderId)) continue;
    visited.add(folderId);

    let pageToken: string | undefined;
    while (true) {
      // We list both videos AND subfolders in one query and dispatch on
      // mimeType client-side — saves a round-trip per level.
      const res: ListResponse = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false and (${VIDEO_MIME_Q} or mimeType = '${DRIVE_FOLDER_MIME}')`,
        fields:
          "nextPageToken,files(id,name,mimeType,size,createdTime,owners(emailAddress,displayName))",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 100,
        pageToken,
      });
      for (const f of res.data.files ?? []) {
        if (!f.id) continue;
        if (f.mimeType === DRIVE_FOLDER_MIME) {
          // Remember this folder's display name before queuing it, so
          // any video we find inside it can resolve its parent name.
          folderNames.set(f.id, f.name ?? f.id);
          if (!visited.has(f.id)) queue.push(f.id);
          continue;
        }
        const parentName =
          folderNames.get(folderId) ?? "Drive Upload";
        files.push({
          id: f.id,
          name: f.name ?? f.id,
          mimeType: f.mimeType ?? null,
          size: f.size ?? null,
          createdTime: f.createdTime ?? null,
          ownerEmail: f.owners?.[0]?.emailAddress ?? null,
          ownerName: f.owners?.[0]?.displayName ?? null,
          parentFolderId: folderId,
          parentFolderName: parentName,
        });
      }
      if (!res.data.nextPageToken) break;
      pageToken = res.data.nextPageToken;
    }
  }

  return { files, foldersWalked: visited.size };
}

/**
 * Insert one Submission + its VideoFile in a single transaction, then enqueue
 * a scoring job. Returns the new submission id and its VideoFile row id so
 * the caller can immediately measure duration. Returns `null` on a
 * unique-constraint race (treat as already-handled).
 */
async function ingestOne(
  file: DriveVideoFile,
  folderId: string,
): Promise<{ submissionId: string; videoFileId: string } | null> {
  const submission = await prisma.$transaction(async (tx) => {
    // Defensive re-check inside the transaction: another worker might have
    // inserted this driveFileId between our list-diff and now.
    const existing = await tx.videoFile.findFirst({
      where: { driveFileId: file.id },
      select: { submissionId: true },
    });
    if (existing) return null;

    const sub = await tx.submission.create({
      data: {
        // Synthetic responseId so the @unique constraint catches re-ingests.
        // "drive-" prefix makes it obvious in the audit log that this row
        // didn't come from the Apps Script webhook.
        responseId: `drive-${file.id}`,
        submitterEmail: file.ownerEmail ?? "unknown@drive.local",
        submitterName:
          file.ownerName ?? file.ownerEmail ?? "Drive upload",
        // Category starts blank for Drive-ingested submissions — the
        // operator decides what to categorise the video as on the
        // dashboard. The immediate parent folder name still gets saved
        // (to `driveFolderName`) so the Phone Provided cell can show
        // which Drive folder the video came from, but it no longer
        // pre-populates the user-facing Category column.
        category: "",
        driveFolderName: file.parentFolderName,
        status: "PENDING",
        files: {
          create: {
            driveFileId: file.id,
            fileName: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.size ? BigInt(file.size) : null,
          },
        },
      },
      include: { files: { select: { id: true, submissionId: true } } },
    });
    await tx.auditLog.create({
      data: {
        actor: "driveFolderIngest",
        action: "submission.create.drive_ingest",
        target: sub.id,
        payload: {
          source: "drive-folder-poll",
          folderId,
          driveFileId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
          driveCreatedTime: file.createdTime,
        },
      },
    });
    return sub;
  });

  if (!submission) return null;

  const q = scoringQueue();
  await q.addBulk(
    submission.files.map((vf) => ({
      name: "score-submission",
      data: { fileId: vf.id, submissionId: vf.submissionId },
      // Same convention as the webhook's enqueue helper. The processor's
      // idempotency check (skip if scoringStatus===COMPLETED) handles any
      // accidental re-enqueue safely.
      opts: { jobId: `score-${vf.id}` as string },
    })),
  );

  const vf = submission.files[0];
  if (!vf) return null;
  return { submissionId: submission.id, videoFileId: vf.id };
}

/**
 * Probe duration for a single Drive file and write it to the matching
 * VideoFile row. Best-effort: a failure here is logged but doesn't break
 * the surrounding ingest loop.
 */
async function fillDurationFor(
  videoFileId: string,
  driveFileId: string,
  fileName: string,
  log = logger,
): Promise<boolean> {
  try {
    const { durationSec, source } =
      await measureDriveVideoDuration(driveFileId);
    if (durationSec == null) {
      log.warn(
        { videoFileId, driveFileId, fileName },
        "drive ingest: could not measure duration (metadata + head + tail all empty)",
      );
      return false;
    }
    await prisma.videoFile.update({
      where: { id: videoFileId },
      data: { durationSec },
    });
    log.info(
      { videoFileId, driveFileId, fileName, durationSec, source },
      "drive ingest: durationSec measured",
    );
    return true;
  } catch (err) {
    log.error(
      {
        videoFileId,
        driveFileId,
        fileName,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      "drive ingest: duration measurement threw",
    );
    return false;
  }
}

/**
 * Metadata sync: when Drive's copy of a known file has drifted, mirror the
 * new fileName / mimeType / sizeBytes into VideoFile. Idempotent — only
 * fields that actually changed are written, so re-runs are no-ops. Scope
 * intentionally broad: both drive-ingested and form-submitted rows are
 * refreshed, since these are pure metadata changes and don't clobber any
 * admin decision (scores, status, category, audit log are untouched).
 *
 * Audit payload only includes the fields that changed, so the log stays
 * tight and grep-able. BigInt size is stringified for JSON safety.
 */
async function syncFileMetadata(
  files: DriveVideoFile[],
  knownByDriveId: Map<
    string,
    {
      id: string;
      fileName: string;
      mimeType: string | null;
      sizeBytes: bigint | null;
      submissionId?: string;
    }
  >,
  log: typeof logger,
): Promise<number> {
  let updated = 0;
  for (const f of files) {
    const row = knownByDriveId.get(f.id);
    if (!row) continue;
    const driveSize: bigint | null = f.size ? BigInt(f.size) : null;
    const dbSize: bigint | null = row.sizeBytes ?? null;
    const data: {
      fileName?: string;
      mimeType?: string | null;
      sizeBytes?: bigint | null;
    } = {};
    const payloadDiff: Record<string, string | null> = {};
    if (row.fileName !== f.name) {
      data.fileName = f.name;
      payloadDiff.previousName = row.fileName;
      payloadDiff.newName = f.name;
    }
    if ((row.mimeType ?? null) !== (f.mimeType ?? null)) {
      data.mimeType = f.mimeType ?? null;
      payloadDiff.previousMimeType = row.mimeType ?? null;
      payloadDiff.newMimeType = f.mimeType ?? null;
    }
    if (driveSize !== dbSize) {
      data.sizeBytes = driveSize;
      payloadDiff.previousSizeBytes = dbSize == null ? null : dbSize.toString();
      payloadDiff.newSizeBytes = driveSize == null ? null : driveSize.toString();
    }
    if (Object.keys(data).length === 0) continue;
    try {
      await prisma.$transaction(async (tx) => {
        const before = await tx.videoFile.findUnique({
          where: { id: row.id },
          select: { submissionId: true },
        });
        if (!before) return;
        await tx.videoFile.update({
          where: { id: row.id },
          data,
        });
        await tx.auditLog.create({
          data: {
            actor: "driveFolderIngest",
            action: "submission.metadata.drive_sync",
            target: before.submissionId,
            payload: {
              videoFileId: row.id,
              driveFileId: f.id,
              ...payloadDiff,
            },
          },
        });
      });
      updated += 1;
      log.info(
        {
          videoFileId: row.id,
          driveFileId: f.id,
          changedFields: Object.keys(data),
        },
        "drive sync: metadata refreshed",
      );
    } catch (err) {
      log.error(
        {
          videoFileId: row.id,
          driveFileId: f.id,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        "drive sync: metadata refresh failed",
      );
    }
  }
  return updated;
}

/**
 * Delete sync: any drive-ingested submission (responseId starts with
 * "drive-") whose VideoFile.driveFileId is NOT in the current Drive scan
 * gets soft-deleted. "Drive folder is the inbox" — once a file leaves the
 * folder tree (deleted, trashed, or moved out), the matching submission
 * leaves the active dashboard too.
 *
 * Scoped to drive-ingested rows only: form/webhook submissions are
 * deliberately untouched because their Drive file lifecycle isn't tied to
 * this folder, and we don't want to surprise admins by trashing their
 * decisions.
 *
 * Reversible: soft-delete only. Admin can restore from /admin/trash, and if
 * the file reappears in Drive a future tick will leave the existing row
 * alone (it'll be in `alreadyKnown`).
 */

/**
 * Folder-name sync: keep `Submission.driveFolderName` aligned with the
 * Drive parent folder's display name. Triggers when a file is moved
 * between folders, when an admin renames the folder, or when retrofitting
 * old rows. Scoped to drive-ingested rows only (responseId starts with
 * "drive-") so form-submitted rows are untouched.
 *
 * Important: we sync `driveFolderName` (auto-derived, read-only on the
 * UI) NOT `category` (user-controlled, starts blank for Drive ingest).
 * Overwriting the operator's manually-typed category every time the
 * folder is renamed would surprise them, so the column they edit and the
 * column we sync are now distinct.
 */
async function syncCategories(
  files: DriveVideoFile[],
  parentByDriveId: Map<
    string,
    {
      submissionId: string;
      currentDriveFolderName: string | null;
      responseId: string;
    }
  >,
  log: typeof logger,
): Promise<number> {
  let updated = 0;
  for (const f of files) {
    const sub = parentByDriveId.get(f.id);
    if (!sub) continue;
    if (!sub.responseId.startsWith("drive-")) continue;
    if (sub.currentDriveFolderName === f.parentFolderName) continue;
    try {
      await prisma.$transaction(async (tx) => {
        const before = await tx.submission.findUnique({
          where: { id: sub.submissionId },
          select: { driveFolderName: true },
        });
        if (!before) return;
        await tx.submission.update({
          where: { id: sub.submissionId },
          data: { driveFolderName: f.parentFolderName },
        });
        await tx.auditLog.create({
          data: {
            actor: "driveFolderIngest",
            action: "submission.drive_folder_name.sync",
            target: sub.submissionId,
            payload: {
              driveFileId: f.id,
              parentFolderId: f.parentFolderId,
              previousDriveFolderName: before.driveFolderName,
              newDriveFolderName: f.parentFolderName,
            },
          },
        });
      });
      updated += 1;
      log.info(
        {
          submissionId: sub.submissionId,
          driveFileId: f.id,
          previousDriveFolderName: sub.currentDriveFolderName,
          newDriveFolderName: f.parentFolderName,
          parentFolderId: f.parentFolderId,
        },
        "drive sync: driveFolderName updated to match Drive folder",
      );
    } catch (err) {
      log.error(
        {
          submissionId: sub.submissionId,
          driveFileId: f.id,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        "drive sync: driveFolderName update failed",
      );
    }
  }
  return updated;
}

/**
 * Sheet sync for drive-ingested submissions.
 *
 * The existing approve/reject flow (notifySubmitter.ts) appends a row to the
 * Score Record sheet whenever an admin makes a decision. That leaves a gap:
 * Drive-uploaded videos that have been auto-scored but not yet decided are
 * not in the sheet.
 *
 * This helper closes the gap. For each drive-ingested submission that:
 *   - has status = SCORED (auto-scored, no admin decision yet),
 *   - is not soft-deleted, and
 *   - has no `submission.sheet_logged.drive_sync` audit entry,
 * append a "SCORED" row to the sheet and write the audit marker so the next
 * tick doesn't double-log.
 *
 * Once admin later approves/rejects, the existing notifySubmitter.ts flow
 * appends another row with that decision — preserving the audit trail.
 */
async function syncDriveSubmissionsToSheet(
  log: typeof logger,
): Promise<number> {
  if (!env.SHEET_ID) return 0;

  const candidates = await prisma.submission.findMany({
    where: {
      responseId: { startsWith: "drive-" },
      deletedAt: null,
      // Only SCORED — the APPROVED/REJECTED flow is handled by
      // notifySubmitter.ts and we don't want to double-write those.
      status: "SCORED",
    },
    select: {
      id: true,
      submitterEmail: true,
      category: true,
      status: true,
      scores: { select: { metric: true, value: true } },
    },
  });
  if (candidates.length === 0) return 0;

  const alreadyLogged = await prisma.auditLog.findMany({
    where: {
      action: "submission.sheet_logged.drive_sync",
      target: { in: candidates.map((c) => c.id) },
    },
    select: { target: true },
  });
  const loggedIds = new Set(alreadyLogged.map((l) => l.target));
  const toLog = candidates.filter((c) => !loggedIds.has(c.id));
  if (toLog.length === 0) return 0;

  let written = 0;
  for (const sub of toLog) {
    try {
      await appendDecisionRow({
        email: sub.submitterEmail,
        category: sub.category,
        status: "SCORED",
        overall: averageMetric(sub.scores, "overall"),
        clarity: averageMetric(sub.scores, "clarity"),
        engagement: averageMetric(sub.scores, "engagement"),
        submissionId: sub.id,
      });
      // Write the marker AFTER the successful append so a transient sheet
      // failure (e.g. quota) leaves the row eligible for the next tick.
      await prisma.auditLog.create({
        data: {
          actor: "driveFolderIngest",
          action: "submission.sheet_logged.drive_sync",
          target: sub.id,
          payload: {
            status: sub.status,
            email: sub.submitterEmail,
            category: sub.category,
          },
        },
      });
      written += 1;
      log.info(
        { submissionId: sub.id, status: sub.status },
        "drive sync: SCORED row appended to sheet",
      );
    } catch (err) {
      log.error(
        {
          submissionId: sub.id,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        "drive sync: sheet append failed",
      );
    }
  }
  return written;
}

export async function softDeleteMissingDriveSubmissions(
  currentDriveIds: Set<string>,
  log: typeof logger,
): Promise<number> {
  const candidates = await prisma.submission.findMany({
    where: {
      responseId: { startsWith: "drive-" },
      deletedAt: null,
    },
    select: {
      id: true,
      status: true,
      files: { select: { driveFileId: true } },
    },
  });

  const stale = candidates.filter(
    (c) =>
      c.files.length > 0 &&
      c.files.every((f) => !currentDriveIds.has(f.driveFileId)),
  );

  if (stale.length === 0) return 0;

  let deleted = 0;
  for (const sub of stale) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.submission.update({
          where: { id: sub.id },
          data: {
            deletedAt: new Date(),
            deletedBy: "driveFolderIngest",
          },
        });
        await tx.auditLog.create({
          data: {
            actor: "driveFolderIngest",
            action: "submission.delete.drive_sync",
            target: sub.id,
            payload: {
              reason: "file no longer present in drive folder tree",
              previousStatus: sub.status,
              driveFileIds: sub.files.map((f) => f.driveFileId),
            },
          },
        });
      });
      deleted += 1;
      log.info(
        {
          submissionId: sub.id,
          driveFileIds: sub.files.map((f) => f.driveFileId),
        },
        "drive sync: submission soft-deleted (drive file gone)",
      );
    } catch (err) {
      log.error(
        {
          submissionId: sub.id,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        "drive sync: soft-delete failed",
      );
    }
  }
  return deleted;
}

/**
 * Fast-path ingest summary: subset of IngestSummary holding only the
 * fields the fast pass produces. Mirrors driveFileIds + newSubmissionIds
 * so the multi-folder caller can union them across folders for the
 * aggregated soft-delete.
 */
export type FastIngestSummary = {
  folderId: string;
  scanned: number;
  foldersWalked: number;
  ingested: number;
  /** Number of VideoFile rows whose Drive-side fileName/mimeType/sizeBytes
   *  changed and were mirrored back this pass. */
  renamed: number;
  /** Drive-ingested submissions whose `driveFolderName` was kept in sync
   *  with the file's parent folder name. */
  categoriesUpdated: number;
  errors: number;
  driveFileIds: string[];
  newSubmissionIds: string[];
};

/**
 * Fast-path ingest for a single folder. Three things only:
 *   1. INSERT new VideoFile rows (no duration measurement — the scoring
 *      queue picks them up async, and the slow tail pass backfills
 *      `durationSec` later)
 *   2. Mirror Drive-side metadata drift (fileName / mimeType / sizeBytes)
 *      back into existing rows
 *   3. Sync `driveFolderName` for drive-ingested rows whose parent
 *      folder changed name (pure DB update, cheap)
 *
 * Skips: duration measurement, sheet sync, soft-delete. Those run in the
 * slow tail pass after Phase 1 has covered every folder.
 *
 * Why this exists: Railway kills the sync subprocess at ~60s. Inline
 * duration measurement (~5-10s per new file, Drive HEAD + ffprobe) means
 * late-alphabet folders never get touched. This pass finishes in
 * ~0.5-1s per folder so all 45 folders fit comfortably inside the
 * 60s budget — and renames + new files land reliably on every tick.
 *
 * Same INSERT path as ingestFromDriveFolder (calls the same ingestOne)
 * so newly-inserted rows are identical down to the audit log entry.
 */
export async function ingestFolderFast(
  folderId: string,
): Promise<FastIngestSummary> {
  const log = logger.child({ folderId, phase: "fast" });
  const { files, foldersWalked } = await listVideosRecursively(folderId);
  log.info(
    { scanned: files.length, foldersWalked },
    "drive folder ingest (fast): listed",
  );

  const currentDriveIds = new Set(files.map((f) => f.id));

  const knownRows =
    files.length === 0
      ? []
      : await prisma.videoFile.findMany({
          where: { driveFileId: { in: files.map((f) => f.id) } },
          select: {
            id: true,
            driveFileId: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            submissionId: true,
            submission: {
              select: { driveFolderName: true, responseId: true },
            },
          },
        });
  const knownByDriveId = new Map(knownRows.map((r) => [r.driveFileId, r]));
  const parentByDriveId = new Map(
    knownRows.map((r) => [
      r.driveFileId,
      {
        submissionId: r.submissionId,
        currentDriveFolderName: r.submission.driveFolderName,
        responseId: r.submission.responseId,
      },
    ]),
  );

  const fresh = files.filter((f) => !knownByDriveId.has(f.id));
  const knownNeedingMetaRefresh = files.filter((f) => {
    const r = knownByDriveId.get(f.id);
    if (!r) return false;
    if (r.fileName !== f.name) return true;
    if ((r.mimeType ?? null) !== (f.mimeType ?? null)) return true;
    const driveSize: bigint | null = f.size ? BigInt(f.size) : null;
    const dbSize: bigint | null = r.sizeBytes ?? null;
    return driveSize !== dbSize;
  });
  const knownNeedingCategory = files.filter((f) => {
    const p = parentByDriveId.get(f.id);
    return (
      p != null &&
      p.responseId.startsWith("drive-") &&
      p.currentDriveFolderName !== f.parentFolderName
    );
  });

  let errors = 0;
  const newSubmissionIds: string[] = [];

  // 1. Insert new rows — NO duration measurement. The slow-tail pass
  //    (ingestFromDriveFolder) will fill durationSec on the next pass
  //    via its existing "knownNeedingDuration" backfill loop.
  for (const f of fresh) {
    try {
      const res = await ingestOne(f, folderId);
      if (!res) continue;
      newSubmissionIds.push(res.submissionId);
    } catch (err) {
      errors += 1;
      log.error(
        {
          driveFileId: f.id,
          fileName: f.name,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        "drive folder ingest (fast): insert failed",
      );
    }
  }

  // 2. Metadata refresh (rename / mime / size)
  let renamed = 0;
  if (knownNeedingMetaRefresh.length > 0) {
    renamed = await syncFileMetadata(
      knownNeedingMetaRefresh,
      knownByDriveId,
      log,
    );
  }

  // 3. Folder-name sync (cheap pure-DB update — pulled forward so a Drive
  //    folder rename also lands inside the 60s budget)
  let categoriesUpdated = 0;
  if (knownNeedingCategory.length > 0) {
    categoriesUpdated = await syncCategories(
      knownNeedingCategory,
      parentByDriveId,
      log,
    );
  }

  log.info(
    {
      scanned: files.length,
      ingested: newSubmissionIds.length,
      renamed,
      categoriesUpdated,
      errors,
    },
    "drive folder ingest (fast): done",
  );

  return {
    folderId,
    scanned: files.length,
    foldersWalked,
    ingested: newSubmissionIds.length,
    renamed,
    categoriesUpdated,
    errors,
    driveFileIds: Array.from(currentDriveIds),
    newSubmissionIds,
  };
}

export async function ingestFromDriveFolder(
  folderId: string = DEFAULT_DRIVE_INGEST_FOLDER_ID,
  options: {
    /** When true, skip the per-folder soft-delete pass. Callers that
     *  iterate over multiple folders (e.g. syncFromSharedDrive's "all
     *  shared folders" sweep) MUST set this and instead run one
     *  aggregated soft-delete with the union of every folder's IDs —
     *  otherwise scanning folder A would soft-delete every video in
     *  folders B, C, D… because each folder's scan only knows its own
     *  IDs. */
    skipSoftDelete?: boolean;
  } = {},
): Promise<IngestSummary> {
  const log = logger.child({ folderId });

  const { files, foldersWalked } = await listVideosRecursively(folderId);
  log.info(
    { scanned: files.length, foldersWalked },
    "drive folder ingest: listed",
  );

  // currentDriveIds is the authoritative "what's in the folder tree right now"
  // set. Drive-sync deletes (below) need this even when files.length === 0:
  // an empty folder should still trigger soft-deletion of any drive-ingested
  // rows that used to live here.
  const currentDriveIds = new Set(files.map((f) => f.id));

  // Diff against the DB by driveFileId. We also fetch fileName, durationSec,
  // and the parent submission's category + responseId so a single query
  // covers rename / null-duration / category-drift detection.
  const knownRows =
    files.length === 0
      ? []
      : await prisma.videoFile.findMany({
          where: { driveFileId: { in: files.map((f) => f.id) } },
          select: {
            id: true,
            driveFileId: true,
            durationSec: true,
            fileName: true,
            // mimeType + sizeBytes are pulled so the metadata-refresh diff
            // below can spot Drive-side changes (re-encode, replace-in-place,
            // mimeType correction) without an extra query per file.
            mimeType: true,
            sizeBytes: true,
            submissionId: true,
            submission: {
              select: {
                driveFolderName: true,
                responseId: true,
              },
            },
          },
        });
  const knownByDriveId = new Map(knownRows.map((r) => [r.driveFileId, r]));
  // Tighter projection used by syncCategories — only needs the parent
  // submission's id, current driveFolderName, and responseId. We sync
  // driveFolderName (not category) because category is now operator-
  // editable and should never be overwritten by ingest.
  const parentByDriveId = new Map(
    knownRows.map((r) => [
      r.driveFileId,
      {
        submissionId: r.submissionId,
        currentDriveFolderName: r.submission.driveFolderName,
        responseId: r.submission.responseId,
      },
    ]),
  );
  const fresh = files.filter((f) => !knownByDriveId.has(f.id));
  const knownNeedingDuration = files.filter((f) => {
    const r = knownByDriveId.get(f.id);
    return r != null && r.durationSec == null;
  });
  // Metadata-refresh diff: pick up Drive-side changes to fileName, mimeType,
  // OR sizeBytes. Renaming a file in Drive is the common case; replace-in-
  // place (same Drive file id, new contents) bumps size; mimeType corrections
  // happen when Drive belatedly re-detects a previously-unknown container.
  const knownNeedingMetaRefresh = files.filter((f) => {
    const r = knownByDriveId.get(f.id);
    if (!r) return false;
    if (r.fileName !== f.name) return true;
    if ((r.mimeType ?? null) !== (f.mimeType ?? null)) return true;
    const driveSize: bigint | null = f.size ? BigInt(f.size) : null;
    const dbSize: bigint | null = r.sizeBytes ?? null;
    return driveSize !== dbSize;
  });
  const knownNeedingCategory = files.filter((f) => {
    const p = parentByDriveId.get(f.id);
    return (
      p != null &&
      p.responseId.startsWith("drive-") &&
      p.currentDriveFolderName !== f.parentFolderName
    );
  });

  log.info(
    {
      alreadyKnown: knownRows.length,
      toIngest: fresh.length,
      knownMissingDuration: knownNeedingDuration.length,
      knownNeedingMetaRefresh: knownNeedingMetaRefresh.length,
      knownNeedingCategory: knownNeedingCategory.length,
    },
    "drive folder ingest: diffed",
  );

  const newSubmissionIds: string[] = [];
  let errors = 0;
  let durationsBackfilled = 0;

  // 1. Ingest new files: insert + enqueue scoring + measure duration inline
  //    so the dashboard never shows "—" for a freshly-ingested row.
  for (const f of fresh) {
    try {
      const res = await ingestOne(f, folderId);
      if (!res) {
        log.warn(
          { driveFileId: f.id },
          "drive folder ingest: row was created concurrently, skipped",
        );
        continue;
      }
      newSubmissionIds.push(res.submissionId);
      log.info(
        {
          submissionId: res.submissionId,
          driveFileId: f.id,
          fileName: f.name,
          owner: f.ownerEmail,
        },
        "drive folder ingest: created submission",
      );
      const measured = await fillDurationFor(
        res.videoFileId,
        f.id,
        f.name,
        log,
      );
      if (measured) durationsBackfilled += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors += 1;
      log.error(
        { driveFileId: f.id, fileName: f.name, errMessage: message },
        "drive folder ingest: failed",
      );
    }
  }

  // 2. Patch up previously-ingested rows that are still missing a duration.
  //    Common cause: the row was created when this script didn't yet measure
  //    inline, OR the file was uploaded to a subfolder we couldn't see, OR
  //    Drive's metadata wasn't ready at scoring time.
  for (const f of knownNeedingDuration) {
    const row = knownByDriveId.get(f.id);
    if (!row) continue;
    try {
      const measured = await fillDurationFor(row.id, f.id, f.name, log);
      if (measured) durationsBackfilled += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors += 1;
      log.error(
        { videoFileId: row.id, driveFileId: f.id, errMessage: message },
        "drive folder ingest: backfill duration failed",
      );
    }
  }

  // 3. Metadata refresh — mirror Drive-side changes to fileName, mimeType,
  //    sizeBytes into the VideoFile row. Bounded by this folder's scan so
  //    unrelated submissions are untouched. `renamed` keeps its historical
  //    name in the return shape; it now counts ANY metadata change (pure
  //    rename, mime correction, replace-in-place), since all three are
  //    "this row's Drive metadata drifted, we resynced it" from the
  //    operator's point of view.
  let renamed = 0;
  if (knownNeedingMetaRefresh.length > 0) {
    renamed = await syncFileMetadata(
      knownNeedingMetaRefresh,
      knownByDriveId,
      log,
    );
  }

  // 4. Category sync — keep Submission.category aligned with each file's
  //    parent folder. Scoped to drive-ingested rows.
  let categoriesUpdated = 0;
  if (knownNeedingCategory.length > 0) {
    categoriesUpdated = await syncCategories(
      knownNeedingCategory,
      parentByDriveId,
      log,
    );
  }

  // 5. Sheet sync — append a "SCORED" row to the Score Record sheet for any
  //    drive-ingested submission that's been auto-scored but not yet logged
  //    there. The approve/reject path keeps writing its own rows on top.
  const sheetRowsLogged = await syncDriveSubmissionsToSheet(log);

  // 6. Delete sync — soft-delete drive-ingested submissions whose Drive file
  //    is missing from the folder tree. Skipped when the caller is going
  //    to run an aggregated soft-delete itself across many folders
  //    (see `skipSoftDelete` on the function signature); otherwise scoped
  //    to this single folder's tree.
  const softDeleted = options.skipSoftDelete
    ? 0
    : await softDeleteMissingDriveSubmissions(currentDriveIds, log);

  return {
    folderId,
    scanned: files.length,
    foldersWalked,
    alreadyKnown: knownRows.length,
    ingested: newSubmissionIds.length,
    durationsBackfilled,
    renamed,
    categoriesUpdated,
    sheetRowsLogged,
    softDeleted,
    errors,
    newSubmissionIds,
    driveFileIds: Array.from(currentDriveIds),
  };
}
