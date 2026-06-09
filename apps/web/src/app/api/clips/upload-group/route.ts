import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
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

const Body = z.object({
  // Drive subfolder name. Slashes will be replaced with _ in the
  // Python script as a defensive measure.
  groupKey: z.string().min(1).max(120),
  // File basenames inside clips/. Validated via resolveClipPath.
  clipNames: z.array(z.string().min(1)).min(1).max(200),
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

  const { groupKey, clipNames } = parsed.data;

  // Validate every name resolves inside clips/. resolveClipPath rejects
  // path traversal, non-.mp4 names, and missing files.
  const valid: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const name of clipNames) {
    const full = resolveClipPath(name);
    if (!full) {
      failed.push({ name, error: "not-found-or-invalid-name" });
    } else {
      valid.push(name);
    }
  }
  if (valid.length === 0) {
    return NextResponse.json(
      { ok: false, reason: "no-valid-files", failed },
      { status: 400 },
    );
  }

  const python = venvPython();
  const exe = fs.existsSync(python) ? python : "python3";

  return new Promise<NextResponse>((resolve) => {
    const handoff = getHandoffFolder();
    const child = spawn(
      exe,
      [
        "upload_group_to_drive.py",
        "--group",
        groupKey,
        ...handoffFolderArgs(),
        "--files",
        ...valid,
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
      // Try to pull the resulting subfolder URL out of the script log.
      const m = log.match(
        /https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+/,
      );
      resolve(
        NextResponse.json(
          {
            ok: code === 0,
            exitCode: code,
            log,
            folderUrl: m ? m[0] : null,
            validated: valid.length,
            skipped: failed,
            destination: handoff,
          },
          { status: code === 0 ? 200 : 500 },
        ),
      );
    });
    child.on("error", (err) => {
      resolve(
        NextResponse.json(
          {
            ok: false,
            error: err.message,
            log: chunks.join(""),
            destination: handoff,
          },
          { status: 500 },
        ),
      );
    });
  });
}
