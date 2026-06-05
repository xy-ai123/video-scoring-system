/**
 * Compute, for every Submission's source Drive folder, the *main* folder
 * it lives under (top-level in the SA's "shared with me" view).
 *
 * Output is JSON to stdout, suitable for the dashboard to cache:
 *
 *   {
 *     "subFolderNameToMain": {
 *       "VPM0166": "Hotel 77",
 *       "VPM0167": "Hotel 77",
 *       "VNM":     "VNM"
 *     },
 *     "knownMains": ["Hotel 77", "VNM"]
 *   }
 *
 * How we compute "main":
 *   1. List every folder the SA can see (across all drives).
 *   2. Build a folderId -> { name, parentId } map.
 *   3. A folder is a *main* if its parent is missing from our map
 *      (the SA can't see it, which means it's outside the SA's
 *       share scope — i.e. the top-level shared folder).
 *   4. For each Submission's `driveFolderName`, find the matching folder
 *      by name (preferring exact match), then walk parents up to the
 *      nearest main and emit { subName -> mainName }.
 *
 * Designed to be cheap to re-run: cold-path takes ~3-5s for ~40 folders.
 * The dashboard caches the result so most page loads don't spawn this.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: "../../.env", override: false });

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@vss/db";
import { getDriveClient } from "../services/drive.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Load the list of Drive folder names that should NOT be treated as a
 * "main" project bucket on the dashboard. Used to filter out staging /
 * inbox / transient folders (e.g. "robot-video-pipeline-incoming"
 * where raw videos live for a few seconds before being moved into a
 * real project folder).
 *
 * Resolution order:
 *   1. DRIVE_MAINS_IGNORE_FILE env var (absolute path)
 *   2. <monorepo-root>/.drive-mains-ignore.txt (the default)
 *
 * Missing file = empty set, which is the original behaviour.
 */
function loadIgnoredMainNames(): Set<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = apps/worker/src/scripts → up four to monorepo root.
  const defaultPath = path.resolve(
    here,
    "..",
    "..",
    "..",
    "..",
    ".drive-mains-ignore.txt",
  );
  const file = process.env.DRIVE_MAINS_IGNORE_FILE || defaultPath;
  const out = new Set<string>();
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      out.add(trimmed);
    }
  } catch {
    // No ignore file → empty set → original behaviour (every visible
    // top-level folder is a candidate main).
  }
  return out;
}

type FolderInfo = { id: string; name: string; parentId: string | null };

async function listAllFolders(): Promise<FolderInfo[]> {
  const drive = getDriveClient();
  const out: FolderInfo[] = [];
  let token: string | undefined;
  do {
    const res = await drive.files.list({
      q: `mimeType = '${FOLDER_MIME}' and trashed = false`,
      pageSize: 1000,
      fields: "nextPageToken, files(id, name, parents)",
      pageToken: token,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    for (const f of res.data.files ?? []) {
      if (!f.id || !f.name) continue;
      out.push({
        id: f.id,
        name: f.name,
        parentId: f.parents?.[0] ?? null,
      });
    }
    token = res.data.nextPageToken ?? undefined;
  } while (token);
  return out;
}

async function main() {
  const folders = await listAllFolders();
  const byId = new Map<string, FolderInfo>();
  for (const f of folders) byId.set(f.id, f);

  // Names that should NEVER be promoted to a main (staging / inbox /
  // transient folders). Loaded from .drive-mains-ignore.txt at the
  // monorepo root. Match is case-sensitive and exact.
  const ignored = loadIgnoredMainNames();

  // A folder is a main if its parent ID isn't in our visible set AND
  // it isn't on the explicit ignore list. The first condition means
  // "this is the highest level the SA can see"; the second prevents
  // a legitimately-top-level Drive folder (e.g. the worker's incoming
  // staging bucket) from showing up as a project.
  //
  // resolveMain() below walks UP from a video's immediate-parent
  // folder looking for the nearest entry in `mainIds`. With ignored
  // folders excluded from `mainIds`, the walk passes THROUGH a
  // staging folder and continues up — and since the staging folder
  // typically has no further SA-visible parent, the walk ends with
  // no match, so the submission's main resolves to null and the
  // dashboard buckets it under "Other".
  const mainIds = new Set<string>();
  for (const f of folders) {
    if (ignored.has(f.name)) continue;
    if (!f.parentId || !byId.has(f.parentId)) {
      mainIds.add(f.id);
    }
  }

  // For each folder, walk up to find its main.
  const mainOf = new Map<string, string>(); // folderId -> mainName
  function resolveMain(folderId: string): string | null {
    if (mainOf.has(folderId)) return mainOf.get(folderId)!;
    const seen = new Set<string>();
    let cursor: string | null = folderId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (mainIds.has(cursor)) {
        const name = byId.get(cursor)?.name ?? null;
        if (name) mainOf.set(folderId, name);
        return name;
      }
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return null;
  }

  // Build name -> mainName by looking up each unique driveFolderName
  // in our folder set. If multiple folders share the name, prefer the
  // one whose own main resolves (avoids picking an orphan match).
  const submissions = await prisma.submission.findMany({
    where: { deletedAt: null },
    select: { driveFolderName: true },
    distinct: ["driveFolderName"],
  });
  const subFolderNameToMain: Record<string, string> = {};
  for (const s of submissions) {
    const name = s.driveFolderName;
    if (!name) continue;
    // All folders whose name matches.
    const candidates = folders.filter((f) => f.name === name);
    let chosen: string | null = null;
    for (const c of candidates) {
      const m = resolveMain(c.id);
      if (m) {
        chosen = m;
        break;
      }
    }
    if (chosen) subFolderNameToMain[name] = chosen;
  }

  // Distinct list of main names that actually map something. Useful for
  // the dashboard to render an empty bucket if no clips land there yet.
  const knownMains = Array.from(new Set(Object.values(subFolderNameToMain))).sort();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ subFolderNameToMain, knownMains }));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  // Emit error to stderr so the JSON-parsing caller doesn't choke.
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
