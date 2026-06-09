import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getCurrentAdmin } from "@/lib/auth";
import {
  getHandoffFolder,
  handoffFolderArgs,
  pipelineRoot,
  resolveClipPath,
  venvPython,
} from "@/lib/clipping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload every clip under a single "main" project (e.g. "VNM",
 * "Hotel 77") into a nested Drive structure:
 *
 *   <HANDOFF>/<MAIN>/<SUB_DATE>/clip.mp4
 *
 * Previously we spawned upload_group_to_drive.py ONCE PER sub-group
 * sequentially. With 5-7 sub-groups that meant 5-7 × (~4s of Python
 * startup + Drive auth + folder lookup) overhead before any bytes
 * moved. Now we serialise a single JSON manifest to a tempfile and
 * spawn the Python script ONCE — it shares one Drive auth, one main-
 * folder lookup, and one 4-worker pool across every group. Net effect
 * on the 18-clip Hotel 77 run: ~30s of spawn overhead → ~4s, on top of
 * the existing 4-way parallel upload speedup.
 *
 * Body schema:
 *   {
 *     mainName: "VNM",
 *     subGroups: [
 *       { groupKey: "VPM0166_23MAY", clipNames: ["a.mp4", "b.mp4"] },
 *       { groupKey: "VPM0167_24_25MAY", clipNames: [...] }
 *     ]
 *   }
 */
const Body = z.object({
  mainName: z.string().min(1).max(120),
  subGroups: z
    .array(
      z.object({
        groupKey: z.string().min(1).max(120),
        clipNames: z.array(z.string().min(1)).min(1).max(500),
      }),
    )
    .min(1)
    .max(50),
});

export async function POST(req: NextRequest) {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { mainName, subGroups } = parsed.data;

  // Validate clip names server-side. resolveClipPath rejects path
  // traversal, non-.mp4 names, and missing files. We do this upfront
  // so the Python script gets a clean manifest and can't be tricked
  // into resolving something outside clips/.
  const cleanSubGroups: Array<{ group: string; files: string[] }> = [];
  const skipped: { groupKey: string; name: string; error: string }[] = [];
  for (const sg of subGroups) {
    const valid: string[] = [];
    for (const name of sg.clipNames) {
      const full = resolveClipPath(name);
      if (!full) {
        skipped.push({
          groupKey: sg.groupKey,
          name,
          error: "not-found-or-invalid-name",
        });
      } else {
        valid.push(name);
      }
    }
    if (valid.length > 0) {
      cleanSubGroups.push({ group: sg.groupKey, files: valid });
    }
  }
  if (cleanSubGroups.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "no-valid-files",
        skipped,
        mainName,
      },
      { status: 400 },
    );
  }

  // Drop the manifest in the OS tempdir — Python reads it via
  // --manifest. Unlink after the child closes (success or failure) so
  // we don't litter /tmp on every run.
  const manifestPath = path.join(
    os.tmpdir(),
    `upload-main-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ main: mainName, groups: cleanSubGroups }),
  );

  const python = venvPython();
  const exe = fs.existsSync(python) ? python : "python3";

  return new Promise<NextResponse>((resolve) => {
    const handoff = getHandoffFolder();
    const child = spawn(
      exe,
      [
        "upload_group_to_drive.py",
        "--manifest",
        manifestPath,
        ...handoffFolderArgs(),
      ],
      {
        cwd: pipelineRoot(),
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      },
    );

    const chunks: string[] = [];
    child.stdout?.on("data", (c) => chunks.push(c.toString("utf8")));
    child.stderr?.on("data", (c) => chunks.push(c.toString("utf8")));
    child.on("close", (code) => {
      const log = chunks.join("");
      // Pull all Drive folder URLs the script logged — last one is the
      // deepest subfolder we touched; user can navigate up to the main.
      const urls = log.match(
        /https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+/g,
      );
      const folderUrl =
        urls && urls.length > 0 ? urls[urls.length - 1] ?? null : null;

      // Parse "moved=X uploaded=Y failed=Z" out of the summary line.
      const tally = log.match(
        /moved=(\d+)\s+uploaded=(\d+)\s+failed=(\d+)/,
      );
      const moved = tally ? Number(tally[1]) : 0;
      const uploaded = tally ? Number(tally[2]) : 0;
      const failed = tally ? Number(tally[3]) : 0;

      try {
        fs.unlinkSync(manifestPath);
      } catch {
        // Best-effort cleanup — leftover JSON in /tmp is harmless.
      }

      resolve(
        NextResponse.json(
          {
            ok: code === 0 && failed === 0,
            mainName,
            exitCode: code,
            moved,
            uploaded,
            failed,
            skipped,
            folderUrl,
            destination: handoff,
            log,
          },
          { status: code === 0 && failed === 0 ? 200 : 207 },
        ),
      );
    });
    child.on("error", (err) => {
      try {
        fs.unlinkSync(manifestPath);
      } catch {
        /* ignore */
      }
      resolve(
        NextResponse.json(
          {
            ok: false,
            mainName,
            error: err.message,
            destination: handoff,
            log: chunks.join(""),
          },
          { status: 500 },
        ),
      );
    });
  });
}
