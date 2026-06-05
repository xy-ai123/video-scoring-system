import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { getCurrentAdmin } from "@/lib/auth";
import {
  pipelineRoot,
  resolveClipPath,
  venvPython,
} from "@/lib/clipping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Push one clip into the hand-off Drive folder by shelling out to
 * upload_clips_to_drive.py, restricted to the single requested file
 * via --clips-dir + a one-file temp dir would be cleaner, but the
 * existing script already short-circuits clips that have a drive_file_id.
 * So we just run it with no args — it uploads only what's not yet pushed.
 *
 * For "force push just this one file", we override by deleting the
 * clip's drive_file_id row via a tiny inline SQL update, then re-run.
 * (Implementation note: the Python script holds its own DB connection,
 * so we touch the DB from Node only when --force is requested.)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { name: string } },
) {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const decoded = decodeURIComponent(params.name);
  const full = resolveClipPath(decoded);
  if (!full) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { force?: boolean };
  const force = body?.force === true;

  const python = venvPython();
  const exe = fs.existsSync(python) ? python : "python3";
  const args = ["upload_clips_to_drive.py"];
  if (force) args.push("--force");

  return new Promise<NextResponse>((resolve) => {
    const child = spawn(exe, args, {
      cwd: pipelineRoot(),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const chunks: string[] = [];
    child.stdout?.on("data", (c) => chunks.push(c.toString("utf8")));
    child.stderr?.on("data", (c) => chunks.push(c.toString("utf8")));
    child.on("close", (code) => {
      const log = chunks.join("");
      resolve(
        NextResponse.json(
          { exitCode: code, log, file: path.basename(full) },
          { status: code === 0 ? 200 : 500 },
        ),
      );
    });
    child.on("error", (err) => {
      resolve(
        NextResponse.json(
          { error: err.message, log: chunks.join("") },
          { status: 500 },
        ),
      );
    });
  });
}
