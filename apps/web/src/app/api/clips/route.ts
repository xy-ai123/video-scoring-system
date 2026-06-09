import { NextResponse } from "next/server";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import {
  listClips,
  listIncoming,
  pipelineRoot,
  clipsDir,
  incomingDir,
  getHandoffFolder,
} from "@/lib/clipping";
import { getDriveMains } from "@/lib/driveMains";
import fs from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Strip the " (clipped)" suffix + extension from a clip filename to get
 * the original source-video stem. detect_hands.py writes:
 *
 *   "VPM0166-23MAY.mp4"               -> "VPM0166-23MAY (clipped).mp4"
 *   "VPM0167-24_25MAY-1.mp4"          -> "VPM0167-24_25MAY-1 (clipped).mp4"
 *
 * It also sanitizes `/` to `_` before writing. So reversing perfectly
 * isn't always possible, but a name-prefix match against the DB's
 * VideoFile.fileName works in practice — that's what the dashboard's
 * isFormClipped already does in the opposite direction.
 */
function sourceStem(clipFileName: string): string {
  return clipFileName
    .replace(/\.mp4$/i, "")
    .replace(/\s*\(clipped\)\s*$/i, "");
}

/**
 * Build a {sanitized-source-stem -> driveFolderName} map by scanning
 * every non-deleted VideoFile. We sanitize the same way detect_hands.py
 * does (`/` -> `_`) so the clip's stem and the source's sanitized stem
 * line up. Done in one query so the per-request cost stays flat
 * regardless of how many clips are on disk.
 */
async function buildStemToFolder(): Promise<Map<string, string>> {
  const files = await prisma.videoFile.findMany({
    where: { submission: { deletedAt: null } },
    select: {
      fileName: true,
      submission: { select: { driveFolderName: true } },
    },
  });
  const out = new Map<string, string>();
  for (const f of files) {
    const folder = f.submission?.driveFolderName;
    if (!folder) continue;
    const sanitized = f.fileName
      .replace(/[\\/]/g, "_")
      .replace(/\.(mp4|mov|avi|mkv)$/i, "");
    // First write wins — typical case is one VideoFile per stem anyway.
    if (!out.has(sanitized)) out.set(sanitized, folder);
  }
  return out;
}

export async function GET() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const root = pipelineRoot();
  if (!fs.existsSync(root)) {
    return NextResponse.json(
      {
        error: "pipeline-not-found",
        message:
          `Robot pipeline folder not found at ${root}. Set ROBOT_PIPELINE_PATH ` +
          "in .env or place the repo at ~/robot-video-pipeline.",
        pipelineRoot: root,
        clips: [],
        incoming: [],
        destination: getHandoffFolder(),
      },
      { status: 200 },
    );
  }

  const clips = listClips();

  // Tag each clip with its main folder. Three lookups deep:
  //   clip.fileName -> source stem -> driveFolderName -> mainName
  // Any miss leaves main = null (UI puts those under "Other").
  let stemToFolder = new Map<string, string>();
  let subFolderNameToMain: Record<string, string> = {};
  try {
    [stemToFolder, { subFolderNameToMain }] = await Promise.all([
      buildStemToFolder(),
      getDriveMains(),
    ]);
  } catch (err) {
    // Don't fail the whole request — degrade to no main tags so the
    // dashboard still loads, just with everything in "Other".
    // eslint-disable-next-line no-console
    console.warn(
      "[api/clips] main resolution failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  for (const c of clips) {
    const folder = stemToFolder.get(sourceStem(c.fileName));
    c.main = folder ? subFolderNameToMain[folder] ?? null : null;
  }

  return NextResponse.json({
    pipelineRoot: root,
    clipsDir: clipsDir(),
    incomingDir: incomingDir(),
    clips,
    incoming: listIncoming(),
    destination: getHandoffFolder(),
  });
}
