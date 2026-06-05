import { NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Identify and (on POST) soft-delete every Submission whose source
 * videos we've conclusively given up on measuring. "Conclusive" means:
 *
 *   1. Every VideoFile attached to the Submission has durationSec=null
 *      (Drive's metadata returned empty, head+tail byte probes found
 *      no moov atom, and the persistence below either skipped ffprobe
 *      via cooldown OR ffprobe also reported no moov).
 *   2. Every one of those files' driveFileIds appears in the worker's
 *      .duration-ffprobe-attempts.json — proof that we ACTUALLY tried
 *      ffprobe at some point. Without this guard, a brand-new upload
 *      with a null durationSec would get nuked before we ever measure
 *      it (its driveFileId wouldn't be in the attempts map yet).
 *
 * GET  — returns the list without changing anything (drives the
 *        confirm dialog).
 * POST — performs the soft-delete in one transaction per row. Returns
 *        the same shape plus a `deleted` count.
 */
function pipelineRoot(): string {
  return (
    process.env.ROBOT_PIPELINE_PATH ||
    path.join(os.homedir(), "robot-video-pipeline")
  );
}

function loadFfprobeAttempts(): Set<string> {
  const file = path.join(pipelineRoot(), ".duration-ffprobe-attempts.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return new Set(Object.keys(parsed));
    }
  } catch {
    // Missing / parse error → empty set → nothing qualifies as corrupt
    // (defensive: we'd rather miss some corrupt rows than nuke a
    // legitimate fresh upload).
  }
  return new Set<string>();
}

type CorruptRow = {
  id: string;
  submitterEmail: string;
  submitterName: string;
  fileNames: string[];
  driveFileIds: string[];
};

async function findCorruptSubmissions(): Promise<CorruptRow[]> {
  const attempted = loadFfprobeAttempts();
  if (attempted.size === 0) {
    // No probe history → there's nothing we've conclusively given up
    // on. Skip the DB query entirely.
    return [];
  }
  // Pull every live submission with its files. We need EVERY file's
  // durationSec to be null AND every driveFileId in the attempt map,
  // which is two independent ANDs — easier to filter in code than
  // in Prisma's relation filters.
  const subs = await prisma.submission.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      submitterEmail: true,
      submitterName: true,
      files: {
        select: { driveFileId: true, durationSec: true, fileName: true },
      },
    },
  });
  const out: CorruptRow[] = [];
  for (const s of subs) {
    if (s.files.length === 0) continue; // no files → not "corrupt"
    const allNull = s.files.every((f) => f.durationSec == null);
    if (!allNull) continue;
    const allAttempted = s.files.every((f) => attempted.has(f.driveFileId));
    if (!allAttempted) continue;
    out.push({
      id: s.id,
      submitterEmail: s.submitterEmail,
      submitterName: s.submitterName,
      fileNames: s.files.map((f) => f.fileName),
      driveFileIds: s.files.map((f) => f.driveFileId),
    });
  }
  return out;
}

export async function GET() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const corrupt = await findCorruptSubmissions();
  return NextResponse.json({ corrupt, count: corrupt.length });
}

export async function POST() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const corrupt = await findCorruptSubmissions();
  if (corrupt.length === 0) {
    return NextResponse.json({ ok: true, deleted: 0, rows: [] });
  }
  // Soft-delete each in its own short transaction so a single failure
  // doesn't abort the whole batch. AuditLog gets one entry per row
  // with the file names for the rollback trail.
  let deleted = 0;
  for (const row of corrupt) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.submission.update({
          where: { id: row.id },
          data: {
            deletedAt: new Date(),
            deletedBy: "delete-corrupt",
          },
        });
        await tx.auditLog.create({
          data: {
            actor: "delete-corrupt",
            action: "submission.delete.corrupt",
            target: row.id,
            payload: {
              reason: "every file's durationSec is null AND ffprobe attempt recorded",
              fileNames: row.fileNames,
              driveFileIds: row.driveFileIds,
            },
          },
        });
      });
      deleted += 1;
    } catch {
      // Skip this row; continue with the rest. Operator can re-run the
      // button to retry the failures.
    }
  }
  return NextResponse.json({
    ok: true,
    deleted,
    rows: corrupt.slice(0, deleted),
  });
}
