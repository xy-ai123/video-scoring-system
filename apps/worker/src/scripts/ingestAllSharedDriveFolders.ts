/**
 * Auto-discover every Drive folder shared with the worker's service account
 * and ingest each of them once. Useful right after the operator opens up
 * access to several new folders (e.g. per-phone or per-date folders) — no
 * need to look up each folder ID by hand.
 *
 * One-shot only; the regular `ingestDriveFolder.ts --watch` keeps polling
 * the default form-responses folder, so this script doesn't need to loop.
 *
 *   pnpm exec tsx src/scripts/ingestAllSharedDriveFolders.ts
 */
import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: "../../.env", override: false });

import { prisma } from "@vss/db";
import { getDriveClient } from "../services/drive.js";
import { ingestFromDriveFolder } from "../services/driveFolderIngest.js";
import { scoringQueue } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

async function listAllFolders(): Promise<{ id: string; name: string }[]> {
  const drive = getDriveClient();
  const out: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `mimeType = '${FOLDER_MIME}' and trashed = false`,
      pageSize: 1000,
      fields: "nextPageToken, files(id, name, parents)",
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

async function main() {
  const folders = await listAllFolders();
  logger.info({ count: folders.length }, "discovered shared folders");

  const totals = {
    folders: 0,
    scanned: 0,
    ingested: 0,
    durationsBackfilled: 0,
    renamed: 0,
    categoriesUpdated: 0,
    softDeleted: 0,
    errors: 0,
  };

  for (const folder of folders) {
    try {
      const summary = await ingestFromDriveFolder(folder.id);
      totals.folders += 1;
      totals.scanned += summary.scanned;
      totals.ingested += summary.ingested;
      totals.durationsBackfilled += summary.durationsBackfilled;
      totals.renamed += summary.renamed;
      totals.categoriesUpdated += summary.categoriesUpdated;
      totals.softDeleted += summary.softDeleted;
      totals.errors += summary.errors;
      logger.info(
        {
          folder: folder.name,
          folderId: folder.id,
          scanned: summary.scanned,
          ingested: summary.ingested,
          durationsBackfilled: summary.durationsBackfilled,
          errors: summary.errors,
        },
        "folder ingest done",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      totals.errors += 1;
      logger.error(
        { folder: folder.name, folderId: folder.id, errMessage: message },
        "folder ingest failed",
      );
    }
  }

  logger.info(totals, "all-shared ingest complete");
  await scoringQueue().close();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  logger.error({ err }, "ingestAllSharedDriveFolders: fatal");
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
