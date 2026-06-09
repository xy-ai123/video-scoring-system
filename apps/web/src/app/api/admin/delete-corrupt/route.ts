import { NextRequest, NextResponse } from "next/server";
// Plain (no `node:` prefix) — see driveSync.ts for why.
import fs from "fs";
import os from "os";
import path from "path";
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

/** Mirrors the threshold used in /admin/page.tsx to compute the
 *  row-level `corrupt` flag. Bumped only if you also bump it there. */
const CORRUPT_PROBE_THRESHOLD = 3;

async function findCorruptSubmissions(): Promise<CorruptRow[]> {
  // Pull every live submission with its files. A submission qualifies
  // as corrupt when EVERY file is unmeasurable. Two independent signals
  // count a file as unmeasurable:
  //   A. The new (Railway-compatible) DB-only path:
  //        durationSec === 0  OR  durationSec IS NULL with
  //        durationProbeAttempts >= CORRUPT_PROBE_THRESHOLD.
  //   B. The legacy local path: durationSec IS NULL AND the file's
  //        driveFileId appears in the worker's
  //        .duration-ffprobe-attempts.json (set the FIRST time we tried
  //        ffprobe on it). Only useful when the dashboard is running on
  //        a developer's Mac next to the local worker.
  // Either signal is enough — the operator's UI badge uses the DB path,
  // the legacy path is kept for back-compat with old local dev setups.
  const attempted = loadFfprobeAttempts();
  const subs = await prisma.submission.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      submitterEmail: true,
      submitterName: true,
      files: {
        select: {
          driveFileId: true,
          durationSec: true,
          durationProbeAttempts: true,
          fileName: true,
        },
      },
    },
  });
  const out: CorruptRow[] = [];
  for (const s of subs) {
    if (s.files.length === 0) continue; // no files → not "corrupt"
    const allCorrupt = s.files.every((f) => {
      // Sub-second values (0, 0.25, 0.99, etc.) are all junk readings —
      // see /admin/page.tsx's corrupt predicate. Operators upload
      // trimmed clips ≥1s.
      if (f.durationSec != null && f.durationSec < 1) return true;
      if (f.durationSec == null) {
        if (f.durationProbeAttempts >= CORRUPT_PROBE_THRESHOLD) return true;
        // Legacy local-Mac fallback: if the worker's local attempts
        // file has this driveFileId, we tried at least once. Combined
        // with the null durationSec, that's "we gave up on the Mac".
        if (attempted.size > 0 && attempted.has(f.driveFileId)) return true;
      }
      return false;
    });
    if (!allCorrupt) continue;
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

export async function POST(req: NextRequest) {
  // CSRF defence — match the per-submission endpoints. Without this,
  // a malicious page could trick a logged-in admin into bulk-soft-
  // deleting every CORRUPT-flagged submission. Reversible via /admin/
  // trash, but still an annoying gap to leave open.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "bad_origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "bad_origin" }, { status: 403 });
    }
  }
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
              reason:
                "every file is unmeasurable (durationSec=0, or null with probeAttempts>=" +
                CORRUPT_PROBE_THRESHOLD +
                ", or legacy local attempt-file match)",
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
