/**
 * Drive ZIP archive ingest.
 *
 * Sibling to `driveFolderIngest` for the case where contributors upload
 * a `.zip` of multiple videos instead of dropping the individual files into
 * Drive. We walk every folder shared with the service account, find ZIPs in
 * each, download them, and create one Submission per video entry inside.
 *
 * Trade-offs:
 *   - The extracted video isn't itself a Drive file, so we set the
 *     `driveFileId` on the synthetic VideoFile row to the *parent ZIP*'s
 *     Drive ID. Clicking "View" in the dashboard opens the ZIP, which is
 *     the closest available source for the original bytes.
 *   - Duration is measured immediately from the extracted bytes (no
 *     Drive byte-probe), so it lands on the dashboard's "Total video
 *     duration" card right away.
 *   - We don't enqueue AI scoring for these; the scorer is built around
 *     re-fetching by `driveFileId`, which would now point at the ZIP
 *     instead of the video. VideoFile.scoringStatus is set to COMPLETED so
 *     the dashboard doesn't show them as stuck pending.
 *   - Re-runs are idempotent: each (zipFileId, entryName) pair maps to a
 *     deterministic `Submission.responseId`, and the @unique constraint
 *     skips already-ingested entries.
 */
import AdmZip from "adm-zip";
import { Readable } from "node:stream";
import { prisma } from "@vss/db";
import { getDriveClient, downloadFile } from "./drive.js";
import {
  parseMp4DurationFromStream,
  parseMp4DurationFromTailBuffer,
} from "./mp4Duration.js";
import { logger } from "../lib/logger.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
// Drive sometimes reports ZIPs as application/x-zip-compressed too.
const ZIP_MIMES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream", // last-resort: rely on extension below
]);
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i;
// Skip macOS metadata + hidden entries that zip from Finder loves to add.
const SKIP_ENTRY = /(^|\/)(__MACOSX\/|\._|\.DS_Store$)/;

export type ZipIngestSummary = {
  zipsScanned: number;
  zipsExtracted: number;
  entriesConsidered: number;
  videosIngested: number;
  videosSkippedAlreadyKnown: number;
  videosSkippedNoDuration: number;
  /** zip-* submissions soft-deleted this run because their source ZIP
   *  was trashed (or otherwise no longer visible) in Drive. Mirrors the
   *  `softDeleted` field on the raw-video ingest summary so the
   *  syncFromSharedDrive caller can surface both counters together. */
  softDeleted: number;
  errors: number;
};

/**
 * Stream a Drive file into memory. We need a full Buffer because adm-zip
 * does random-access reads from the central directory at the *end* of the
 * archive — streaming a ZIP is awkward. Caps memory at ~500 MB to keep
 * one runaway upload from OOM-ing the worker.
 */
async function downloadToBuffer(
  fileId: string,
  capBytes = 512 * 1024 * 1024,
): Promise<Buffer> {
  const { stream } = await downloadFile(fileId);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    total += chunk.length;
    if (total > capBytes) {
      throw new Error(
        `ZIP exceeds ${capBytes} byte cap while downloading (${total} so far)`,
      );
    }
  }
  return Buffer.concat(chunks);
}

async function measureDurationFromBuffer(buf: Buffer): Promise<number | null> {
  // Try the front-loaded moov first (cheap; covers most files).
  const fromFront = await parseMp4DurationFromStream(Readable.from(buf));
  if (fromFront != null) return fromFront;
  // Smartphone-style MP4s with trailing moov.
  return parseMp4DurationFromTailBuffer(buf);
}

type ZipFileMeta = {
  id: string;
  name: string;
  parentFolderId: string;
  parentFolderName: string;
  ownerEmail: string | null;
  ownerName: string | null;
};

async function listZipsInSharedFolders(): Promise<ZipFileMeta[]> {
  const drive = getDriveClient();
  // 1. Find every folder the SA can see.
  const folders: { id: string; name: string }[] = [];
  let token: string | undefined;
  do {
    const res = await drive.files.list({
      q: `mimeType = '${FOLDER_MIME}' and trashed = false`,
      pageSize: 1000,
      fields: "nextPageToken, files(id, name)",
      pageToken: token,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) folders.push({ id: f.id, name: f.name });
    }
    token = res.data.nextPageToken ?? undefined;
  } while (token);

  // 2. For each folder, find ZIP-shaped files. Match by MIME *or* extension —
  //    some uploaders end up with `application/octet-stream` from Drive
  //    when the client-side MIME sniffer didn't recognize the file.
  const zips: ZipFileMeta[] = [];
  for (const folder of folders) {
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${folder.id}' in parents and trashed = false`,
        pageSize: 1000,
        fields:
          "nextPageToken, files(id, name, mimeType, owners(emailAddress, displayName))",
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name) continue;
        const looksLikeZip =
          (f.mimeType && ZIP_MIMES.has(f.mimeType)) ||
          /\.zip$/i.test(f.name);
        if (!looksLikeZip) continue;
        zips.push({
          id: f.id,
          name: f.name,
          parentFolderId: folder.id,
          parentFolderName: folder.name,
          ownerEmail: f.owners?.[0]?.emailAddress ?? null,
          ownerName: f.owners?.[0]?.displayName ?? null,
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  return zips;
}

async function ingestOneZip(
  zip: ZipFileMeta,
  summary: ZipIngestSummary,
): Promise<void> {
  const log = logger.child({ zipFileId: zip.id, zipName: zip.name });
  log.info({ folder: zip.parentFolderName }, "zip ingest: downloading");
  let buf: Buffer;
  try {
    buf = await downloadToBuffer(zip.id);
  } catch (err) {
    summary.errors += 1;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ errMessage: message }, "zip ingest: download failed");
    return;
  }
  summary.zipsExtracted += 1;

  let archive: AdmZip;
  try {
    archive = new AdmZip(buf);
  } catch (err) {
    summary.errors += 1;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ errMessage: message }, "zip ingest: archive open failed");
    return;
  }

  const entries = archive.getEntries();
  log.info({ entryCount: entries.length }, "zip ingest: opened");

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName;
    if (SKIP_ENTRY.test(entryName)) continue;
    summary.entriesConsidered += 1;
    if (!VIDEO_EXT.test(entryName)) continue;

    // Stable response ID — re-runs with the same ZIP + entry skip idempotently.
    const responseId = `zip-${zip.id}-${entryName}`;
    const exists = await prisma.submission.findUnique({
      where: { responseId },
      select: { id: true },
    });
    if (exists) {
      summary.videosSkippedAlreadyKnown += 1;
      continue;
    }

    const entryBuf = entry.getData();
    const durationSec = await measureDurationFromBuffer(entryBuf);
    if (durationSec == null) {
      log.warn(
        { entryName, sizeBytes: entryBuf.length },
        "zip ingest: could not measure duration; skipping",
      );
      summary.videosSkippedNoDuration += 1;
      continue;
    }

    // Best-effort MIME based on extension (Drive ZIP doesn't carry per-entry MIME).
    const lower = entryName.toLowerCase();
    const mimeType = lower.endsWith(".mp4")
      ? "video/mp4"
      : lower.endsWith(".mov")
        ? "video/quicktime"
        : lower.endsWith(".webm")
          ? "video/webm"
          : lower.endsWith(".mkv")
            ? "video/x-matroska"
            : lower.endsWith(".avi")
              ? "video/x-msvideo"
              : lower.endsWith(".3gp")
                ? "video/3gpp"
                : "video/mp4";

    await prisma.$transaction(async (tx) => {
      const sub = await tx.submission.create({
        data: {
          responseId,
          submitterEmail: zip.ownerEmail ?? "unknown@drive.local",
          submitterName: zip.ownerName ?? zip.ownerEmail ?? "Drive ZIP upload",
          // Category starts blank for Drive-ingested submissions; the
          // operator manually categorises each video on the dashboard.
          // The parent folder name is still preserved (on
          // `driveFolderName`) so the Phone Provided cell can show where
          // the video came from.
          category: "",
          driveFolderName: zip.parentFolderName,
          status: "PENDING",
          files: {
            create: {
              // Point the synthetic VideoFile back at the ZIP — clicking
              // "View" in the dashboard opens the source archive.
              driveFileId: zip.id,
              fileName: entryName,
              mimeType,
              sizeBytes: BigInt(entryBuf.length),
              durationSec,
              // We can't re-fetch this entry from Drive on demand, so mark
              // it COMPLETED — keeps it out of the "pending scoring" view.
              scoringStatus: "COMPLETED",
              processedAt: new Date(),
            },
          },
        },
      });
      await tx.auditLog.create({
        data: {
          actor: "zipIngest",
          action: "submission.create.zip_ingest",
          target: sub.id,
          payload: {
            source: "drive-zip-extract",
            zipFileId: zip.id,
            zipName: zip.name,
            parentFolderId: zip.parentFolderId,
            parentFolderName: zip.parentFolderName,
            entryName,
            entrySizeBytes: String(entryBuf.length),
            durationSec,
          },
        },
      });
    });

    summary.videosIngested += 1;
    log.info(
      { entryName, durationSec, sizeBytes: entryBuf.length },
      "zip ingest: extracted video",
    );
  }
}

/**
 * Soft-delete zip-* submissions whose source ZIP is no longer present
 * (trashed in Drive, or otherwise not visible to the worker's service
 * account). Mirrors `softDeleteMissingDriveSubmissions` but scoped to
 * the zip ingest path — the existing drive-* pass skips zip-* rows
 * entirely because it filters on `responseId starts with "drive-"`.
 *
 * Match logic: a submission whose VideoFile.driveFileId points at a
 * ZIP ID that isn't in `currentZipIds` is stale and gets soft-deleted.
 * `currentZipIds` should be the union of every live (non-trashed) ZIP
 * the SA can see across every shared folder — `listZipsInSharedFolders`
 * already filters out trashed entries, so passing that result's IDs
 * here is the correct input.
 */
export async function softDeleteMissingZipSubmissions(
  currentZipIds: Set<string>,
  log: typeof logger,
): Promise<number> {
  const candidates = await prisma.submission.findMany({
    where: {
      responseId: { startsWith: "zip-" },
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
      c.files.every((f) => !currentZipIds.has(f.driveFileId)),
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
            deletedBy: "zipIngest",
          },
        });
        await tx.auditLog.create({
          data: {
            actor: "zipIngest",
            action: "submission.delete.zip_sync",
            target: sub.id,
            payload: {
              reason: "source ZIP no longer present in shared drives",
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
        "zip ingest: submission soft-deleted (source ZIP gone)",
      );
    } catch (err) {
      log.error(
        {
          submissionId: sub.id,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        "zip ingest: soft-delete failed",
      );
    }
  }
  return deleted;
}

export async function ingestZipsFromSharedDrives(): Promise<ZipIngestSummary> {
  const zips = await listZipsInSharedFolders();
  const summary: ZipIngestSummary = {
    zipsScanned: zips.length,
    zipsExtracted: 0,
    entriesConsidered: 0,
    videosIngested: 0,
    videosSkippedAlreadyKnown: 0,
    videosSkippedNoDuration: 0,
    softDeleted: 0,
    errors: 0,
  };
  logger.info({ count: zips.length }, "zip ingest: found ZIPs");
  for (const zip of zips) {
    try {
      await ingestOneZip(zip, summary);
    } catch (err) {
      summary.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { zipFileId: zip.id, zipName: zip.name, errMessage: message },
        "zip ingest: per-zip error",
      );
    }
  }

  // After ingest, drop submissions whose source ZIP was trashed. We
  // compare against the set of live ZIP IDs we just listed — anything
  // not in that set has been trashed (or moved out of an SA-shared
  // folder, which from the SA's perspective is the same thing).
  try {
    const liveZipIds = new Set(zips.map((z) => z.id));
    summary.softDeleted = await softDeleteMissingZipSubmissions(
      liveZipIds,
      logger,
    );
  } catch (err) {
    summary.errors += 1;
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { errMessage: message },
      "zip ingest: soft-delete pass failed",
    );
  }

  return summary;
}
