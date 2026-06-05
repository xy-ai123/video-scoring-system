/**
 * Diagnostic: list everything (any MIME type, not just videos) inside a
 * given Drive folder. Used to figure out why a shared folder appears empty
 * from the ingester's perspective.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: "../../.env", override: false });
import { getDriveClient } from "../services/drive.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

async function main() {
  const drive = getDriveClient();
  // Discover every shared folder, then list its direct contents (any MIME).
  const all = await drive.files.list({
    q: `mimeType = '${FOLDER_MIME}' and trashed = false`,
    pageSize: 1000,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
  });
  const folders = all.data.files ?? [];
  for (const folder of folders) {
    console.log(`\n--- ${folder.name}  (${folder.id}) ---`);
    const res = await drive.files.list({
      q: `'${folder.id}' in parents and trashed = false`,
      pageSize: 1000,
      fields: "files(id, name, mimeType, size, owners(emailAddress))",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (!res.data.files?.length) {
      console.log("  (empty)");
      continue;
    }
    for (const f of res.data.files) {
      console.log(
        `  ${f.id}  ${f.name}  mime=${f.mimeType}  size=${f.size}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
