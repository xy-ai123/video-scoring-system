/**
 * Diagnostic: list every folder + video the worker's service account can
 * currently access. Useful right after sharing a Drive folder with the SA
 * to confirm permissions landed, and to look up the folder ID we should
 * pass to the regular ingest script.
 *
 *   pnpm exec tsx src/scripts/listAccessibleDrive.ts
 */
import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: "../../.env", override: false });

import { getDriveClient } from "../services/drive.js";

const VIDEO_MIME_Q =
  "(mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.video')";
const FOLDER_MIME = "application/vnd.google-apps.folder";

async function listAll(query: string) {
  const drive = getDriveClient();
  const out: {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    owners?: string;
    shared?: boolean;
    size?: string;
  }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: query,
      pageSize: 1000,
      fields:
        "nextPageToken, files(id, name, mimeType, parents, owners(emailAddress), shared, size)",
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    for (const f of res.data.files ?? []) {
      out.push({
        id: f.id!,
        name: f.name ?? "(unnamed)",
        mimeType: f.mimeType ?? "?",
        parents: f.parents ?? undefined,
        owners: f.owners?.map((o) => o.emailAddress ?? "?").join(",") ?? "?",
        shared: f.shared ?? undefined,
        size: f.size ?? undefined,
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function main() {
  console.log("\n=== Folders visible to the service account ===");
  const folders = await listAll(
    `mimeType = '${FOLDER_MIME}' and trashed = false`,
  );
  if (folders.length === 0) {
    console.log("  (none — nothing shared with the SA yet)");
  } else {
    for (const f of folders) {
      console.log(
        `  ${f.id}  ${f.name}   parents=${(f.parents ?? []).join(",")}   owner=${f.owners}   shared=${f.shared}`,
      );
    }
  }

  console.log("\n=== Video files visible to the service account ===");
  const videos = await listAll(`${VIDEO_MIME_Q} and trashed = false`);
  if (videos.length === 0) {
    console.log("  (none)");
  } else {
    for (const v of videos) {
      console.log(
        `  ${v.id}  ${v.name}   mime=${v.mimeType}   parents=${(v.parents ?? []).join(",")}   size=${v.size ?? "?"}`,
      );
    }
  }

  console.log(
    `\nSummary: ${folders.length} folder(s), ${videos.length} video(s) reachable.`,
  );
}

main().catch((err) => {
  console.error("listAccessibleDrive: fatal", err);
  process.exit(1);
});
