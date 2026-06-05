/**
 * One-shot repair script.
 *
 * Earlier, `syncFromSharedDrive.ts` had a soft-delete bug — when looping
 * over multiple shared folders, each folder's scan ran the per-folder
 * soft-delete pass against only THAT folder's IDs, so every drive-
 * ingested submission in folders B, C, D, … got soft-deleted by folder
 * A's pass (and vice versa). The fix has shipped; this script repairs
 * the rows the bug deleted:
 *
 *   1. Find every soft-deleted `drive-*` Submission.
 *   2. Look up each row's Drive file (by driveFileId) — if it's still
 *      reachable, capture its true parent folder name.
 *   3. Restore the row (clear deletedAt + deletedBy) and set
 *      `driveFolderName` to the real folder, plus `category = ""` to
 *      match the current ingest behaviour. Rows whose Drive file is
 *      genuinely gone stay deleted (correct outcome).
 *
 *   pnpm exec tsx src/scripts/repairDriveSubmissions.ts
 */
import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: "../../.env", override: false });

import { prisma } from "@vss/db";
import { getDriveClient } from "../services/drive.js";
import { logger } from "../lib/logger.js";

async function getFileParent(
  driveFileId: string,
): Promise<{ parentId: string | null; parentName: string | null } | null> {
  const drive = getDriveClient();
  try {
    const file = await drive.files.get({
      fileId: driveFileId,
      fields: "id,name,parents,trashed",
      supportsAllDrives: true,
    });
    if (file.data.trashed) return null;
    const parentId = file.data.parents?.[0] ?? null;
    if (!parentId) return { parentId: null, parentName: null };
    const parent = await drive.files.get({
      fileId: parentId,
      fields: "id,name",
      supportsAllDrives: true,
    });
    return { parentId, parentName: parent.data.name ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ driveFileId, errMessage: msg }, "drive lookup failed");
    return null;
  }
}

async function main() {
  // Pull every soft-deleted drive-* row with its file IDs.
  const candidates = await prisma.submission.findMany({
    where: {
      responseId: { startsWith: "drive-" },
      deletedAt: { not: null },
    },
    select: {
      id: true,
      responseId: true,
      category: true,
      driveFolderName: true,
      status: true,
      files: { select: { driveFileId: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  logger.info({ count: candidates.length }, "repair: soft-deleted drive rows");

  let restored = 0;
  let stillMissing = 0;
  let failed = 0;
  for (const sub of candidates) {
    // First VideoFile is enough — by construction drive-ingested
    // submissions have exactly one file row pointing at the Drive file.
    const driveFileId = sub.files[0]?.driveFileId;
    if (!driveFileId) {
      logger.warn(
        { submissionId: sub.id },
        "repair: skipping row with no files",
      );
      continue;
    }
    const lookup = await getFileParent(driveFileId);
    if (!lookup) {
      // File is genuinely gone from Drive (or SA lost access). Leave the
      // row soft-deleted — that's the correct end state.
      stillMissing += 1;
      continue;
    }
    const folderName = lookup.parentName ?? "Drive";
    try {
      await prisma.$transaction(async (tx) => {
        await tx.submission.update({
          where: { id: sub.id },
          data: {
            deletedAt: null,
            deletedBy: null,
            driveFolderName: folderName,
            // Snap category to empty so the row matches the new
            // "Drive-ingested = blank, operator-editable" UX. If the
            // operator had previously typed a category we'd preserve it,
            // but these rows all carry the hard-coded "Drive" placeholder
            // from the pre-fix ingest, which is no longer meaningful.
            category: "",
          },
        });
        await tx.auditLog.create({
          data: {
            actor: "repairDriveSubmissions",
            action: "submission.restore.repair",
            target: sub.id,
            payload: {
              driveFileId,
              previousDriveFolderName: sub.driveFolderName,
              newDriveFolderName: folderName,
              previousCategory: sub.category,
            },
          },
        });
      });
      restored += 1;
      logger.info(
        {
          submissionId: sub.id,
          driveFileId,
          driveFolderName: folderName,
        },
        "repair: restored",
      );
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ submissionId: sub.id, errMessage: msg }, "repair: failed");
    }
  }

  logger.info(
    {
      candidates: candidates.length,
      restored,
      stillMissing,
      failed,
    },
    "repair: complete",
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  logger.error({ err }, "repair: fatal");
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
