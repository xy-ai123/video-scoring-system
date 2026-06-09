/**
 * Bridge between the Next.js dashboard and the Python clipping pipeline
 * at ~/robot-video-pipeline.
 *
 * The pipeline lives in its own folder and has its own SQLite DB
 * (pipeline.db) tracking clip state. We read that DB read-only, list
 * files in clips/, and shell out to the pipeline's Python scripts
 * (pull_from_drive.py + detect_hands.py + upload_clips_to_drive.py) when
 * the user clicks "Run clipping now".
 *
 * IMPORTANT: this only works when the dashboard is running on the same
 * machine as the Python pipeline. Deploying apps/web to a remote host
 * without the Python project will fail at runtime.
 */

// Plain (no `node:` prefix). See driveSync.ts for context — Next.js's
// instrumentation hook + Edge fallback pass trips UnhandledSchemeError
// on `node:` URIs.
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import Database from "better-sqlite3";
import { prisma } from "@vss/db";

/** Where ~/robot-video-pipeline lives. Configurable via env. */
export function pipelineRoot(): string {
  const fromEnv = process.env.ROBOT_PIPELINE_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.homedir(), "robot-video-pipeline");
}

export function clipsDir(): string {
  return path.join(pipelineRoot(), "clips");
}

export function incomingDir(): string {
  return path.join(pipelineRoot(), "incoming");
}

export function dbPath(): string {
  return path.join(pipelineRoot(), "pipeline.db");
}

/** Path to the Python interpreter inside the pipeline's venv. */
export function venvPython(): string {
  return path.join(pipelineRoot(), "venv", "bin", "python");
}

/**
 * The destination Drive folder clipped videos get uploaded to (the
 * "Robot Video Pipeline" hand-off folder). Sourced from env vars:
 *   HANDOFF_DRIVE_FOLDER_ID    — the Drive folder ID (required to override)
 *   HANDOFF_DRIVE_FOLDER_NAME  — display name (defaults to "Robot Video Pipeline")
 *
 * If HANDOFF_DRIVE_FOLDER_ID is unset, `id` is null and `handoffFolderArgs()`
 * returns []. The Python upload scripts then fall back to their own
 * hardcoded HANDOFF_FOLDER_ID constant — so this is purely additive.
 */
export type HandoffFolder = { id: string | null; name: string };

export function getHandoffFolder(): HandoffFolder {
  const rawId = (process.env.HANDOFF_DRIVE_FOLDER_ID ?? "").trim();
  const rawName = (process.env.HANDOFF_DRIVE_FOLDER_NAME ?? "").trim();
  return {
    id: rawId.length > 0 ? rawId : null,
    name: rawName.length > 0 ? rawName : "Robot Video Pipeline",
  };
}

/** Returns ["--folder", id] when the env var is set; [] otherwise. */
export function handoffFolderArgs(): string[] {
  const { id } = getHandoffFolder();
  return id ? ["--folder", id] : [];
}

/**
 * Open pipeline.db. Returns null if the DB doesn't exist yet (the user
 * hasn't run import_to_db.py once). Callers should fall back to scanning
 * the clips/ folder directly.
 */
function openDb(): Database.Database | null {
  const p = dbPath();
  if (!fs.existsSync(p)) return null;
  // readonly: we never write to the Python DB from Node.
  return new Database(p, { readonly: true, fileMustExist: true });
}

/**
 * Open pipeline.db with write access (for delete). Returns null if the
 * DB doesn't exist yet. Caller is responsible for closing.
 *
 * SQLite serializes writers; if detect_hands.py is currently importing
 * to the DB at the same instant, this will wait up to `timeout` ms.
 */
function openDbWritable(): Database.Database | null {
  const p = dbPath();
  if (!fs.existsSync(p)) return null;
  const db = new Database(p, { fileMustExist: true });
  db.pragma("busy_timeout = 3000");
  return db;
}

export type ClipRow = {
  /** filename stem, e.g. 'rgb(2)_clip_014' */
  clipId: string;
  /** absolute path to the .mp4 on disk */
  clipPath: string;
  /** filename including extension, used as the download URL key */
  fileName: string;
  /** size in bytes (from fs.stat) */
  sizeBytes: number;
  /** ISO mtime of the file on disk */
  mtime: string;
  durationSeconds: number | null;
  activityLabel: string | null;
  score: number | null;
  driveFileId: string | null;
  uploadedAt: string | null;
  /** Top-level shared-Drive folder this clip belongs to (e.g. "VNM",
   *  "Hotel 77"). Computed by looking up the source Submission's
   *  driveFolderName in the SA's folder graph. Null when we can't
   *  resolve a main — those clips land in the "Other" bucket. */
  main: string | null;
};

/**
 * List clips by joining (a) the .mp4 files on disk and (b) any rows in
 * pipeline.db. Disk is the source of truth for existence — DB rows
 * without a matching file are omitted, files without a DB row still
 * show up (with nulls).
 */
export function listClips(): ClipRow[] {
  const dir = clipsDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".mp4"))
    .map((d) => d.name);

  const db = openDb();
  const byId = new Map<string, Record<string, unknown>>();
  if (db) {
    try {
      const rows = db
        .prepare(
          "SELECT clip_id, clip_path, duration_seconds, activity_label, " +
            "score, drive_file_id, uploaded_at FROM clips",
        )
        .all() as Array<Record<string, unknown>>;
      for (const r of rows) byId.set(String(r.clip_id), r);
    } catch {
      // Schema mismatch (e.g. drive_file_id column not yet migrated).
      // Fall through with empty map.
    } finally {
      db.close();
    }
  }

  const out: ClipRow[] = [];
  for (const fileName of files) {
    const full = path.join(dir, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const clipId = fileName.replace(/\.mp4$/i, "");
    const row = byId.get(clipId) ?? {};
    out.push({
      clipId,
      clipPath: full,
      fileName,
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      durationSeconds:
        typeof row.duration_seconds === "number" ? row.duration_seconds : null,
      activityLabel:
        typeof row.activity_label === "string" ? row.activity_label : null,
      score: typeof row.score === "number" ? row.score : null,
      driveFileId:
        typeof row.drive_file_id === "string" ? row.drive_file_id : null,
      uploadedAt:
        typeof row.uploaded_at === "string" ? row.uploaded_at : null,
      // Populated by the API route via getDriveMains() — listClips() is
      // sync + filesystem-only, so it leaves this null.
      main: null,
    });
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

export type IncomingRow = {
  fileName: string;
  fullPath: string;
  sizeBytes: number;
  mtime: string;
};

/** Raw videos sitting in incoming/ that haven't been clipped yet. */
export function listIncoming(): IncomingRow[] {
  const dir = incomingDir();
  if (!fs.existsSync(dir)) return [];
  const exts = new Set([".mp4", ".mov", ".avi", ".mkv"]);
  const rows: IncomingRow[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isFile() || d.name.startsWith(".")) continue;
    const ext = path.extname(d.name).toLowerCase();
    if (!exts.has(ext)) continue;
    const full = path.join(dir, d.name);
    try {
      const stat = fs.statSync(full);
      rows.push({
        fileName: d.name,
        fullPath: full,
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch {
      // skip unreadable files
    }
  }
  rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return rows;
}

/**
 * Resolve a filename from the API path back to an on-disk clip.
 * Refuses path-traversal — name must be a bare filename with no /, ..,
 * etc., and must end in .mp4.
 */
export function resolveClipPath(name: string): string | null {
  if (!name) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  if (!/^[\w.\-() ]+\.mp4$/i.test(name)) return null;
  const full = path.join(clipsDir(), name);
  if (!fs.existsSync(full)) return null;
  return full;
}

// -----------------------------------------------------------------------------
// "Run clipping" — manages the long-running Python subprocess.
// Only one run at a time. State is held in module memory (process-local),
// which is fine for the single-user local-dashboard setup.
// -----------------------------------------------------------------------------

export type RunState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  /** Last ~200 lines of combined stdout/stderr. */
  log: string[];
  /** Which step is currently running. */
  step:
    | "idle"
    | "pull_from_drive"
    | "pull_form_submissions"
    | "detect_hands"
    | "upload_clips_to_drive"
    | "done"
    | "error";
};

const MAX_LOG_LINES = 200;
const state: RunState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  log: [],
  step: "idle",
};
let activeChild: ChildProcess | null = null;

function pushLog(line: string): void {
  state.log.push(line);
  if (state.log.length > MAX_LOG_LINES) {
    state.log.splice(0, state.log.length - MAX_LOG_LINES);
  }
}

function runStep(script: string, args: string[] = []): Promise<number> {
  return new Promise((resolve) => {
    const python = venvPython();
    const exe = fs.existsSync(python) ? python : "python3";
    pushLog(`$ ${exe} ${script} ${args.join(" ")}`);

    const child = spawn(exe, [script, ...args], {
      cwd: pipelineRoot(),
      env: {
        ...process.env,
        // Force unbuffered stdout so progress lines stream live.
        PYTHONUNBUFFERED: "1",
      },
    });
    activeChild = child;

    const onLine = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) pushLog(line);
      }
    };
    child.stdout?.on("data", onLine);
    child.stderr?.on("data", onLine);

    child.on("close", (code) => {
      pushLog(`-> exit ${code ?? -1}`);
      activeChild = null;
      resolve(code ?? -1);
    });
    child.on("error", (err) => {
      pushLog(`! spawn error: ${err.message}`);
      activeChild = null;
      resolve(-1);
    });
  });
}

export function getRunState(): RunState {
  // Shallow copy so callers can serialize without exposing mutation.
  return { ...state, log: state.log.slice() };
}

/**
 * Query Postgres for pending Submission rows and write their
 * Drive file IDs + filenames to a list file inside the pipeline folder.
 *
 * Format: `<driveFileId>\t<fileName>` per line. The two Python scripts
 * read this:
 *   - pull_from_drive.py: uses the filename column to spare these from
 *     prune so they survive between runs.
 *   - pull_form_submissions.py: downloads each driveFileId into
 *     incoming/ if not already present.
 *
 * "Pending" = anything that isn't APPROVED/REJECTED/FAILED and isn't
 * soft-deleted. We dedupe by driveFileId so a re-submission of the same
 * video doesn't appear twice.
 */
/**
 * Sanitize a form-submitted filename so it can safely be the basename
 * of a file inside incoming/. Form respondents have been observed
 * uploading names like `VPM0167-24/25MAY-1.mp4` where the `/` is a date
 * range, not a path separator. Replace path-affecting characters with
 * `_` so the file lands at one path and both Python scripts see the
 * same basename (important — pull_from_drive's prune-keep list and
 * pull_form_submissions's download target must agree).
 */
function safeBasename(raw: string): string {
  // Replace path-affecting and control chars with `_`. Whitespace is
  // left alone (legitimate in many real filenames).
  const cleaned = raw
    .replace(/[\\/]/g, "_")
    .replace(/[\x00-\x1f]/g, "_")
    .replace(/^\.+/, "_"); // refuse a leading-dot name so we don't write a dotfile
  return cleaned || "file";
}

async function writeFormSubmissionList(): Promise<{
  listPath: string;
  count: number;
}> {
  const listPath = path.join(pipelineRoot(), ".pending-form-files.txt");

  let entries: Array<{ driveFileId: string; fileName: string }> = [];
  try {
    const subs = await prisma.submission.findMany({
      where: {
        deletedAt: null,
        status: { in: ["PENDING", "SCORING", "SCORED"] },
      },
      include: {
        files: {
          select: { driveFileId: true, fileName: true },
        },
      },
    });
    const seen = new Set<string>();
    for (const s of subs) {
      for (const f of s.files) {
        if (!f.driveFileId || !f.fileName) continue;
        if (seen.has(f.driveFileId)) continue;
        seen.add(f.driveFileId);
        entries.push({
          driveFileId: f.driveFileId,
          fileName: safeBasename(f.fileName),
        });
      }
    }
  } catch (e) {
    pushLog(
      `! could not read pending submissions from Postgres: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    entries = [];
  }

  const header =
    "# Pending form-submission videos, regenerated by the dashboard on every run.\n" +
    "# Format: <driveFileId>\\t<fileName>\n";
  const body = entries
    .map((e) => `${e.driveFileId}\t${e.fileName}`)
    .join("\n");

  try {
    fs.writeFileSync(listPath, header + body + (body ? "\n" : ""), "utf8");
  } catch (e) {
    pushLog(
      `! could not write ${listPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  pushLog(
    `wrote ${entries.length} pending form-submission file(s) to ${path.basename(
      listPath,
    )}`,
  );
  return { listPath, count: entries.length };
}

/**
 * Kick off the full pull -> detect -> upload chain.
 * Returns immediately; poll getRunState() for progress.
 */
export function startClippingRun(opts?: {
  /** Skip the Drive pull (use whatever's already in incoming/). */
  skipPull?: boolean;
  /** Skip uploading clipped output to the hand-off Drive folder. */
  skipUpload?: boolean;
  /** Restrict pull_from_drive.py to a specific Drive folder ID. */
  folderId?: string;
  /**
   * If set, only clip these specific files in incoming/ (passed to
   * detect_hands.py via --files). Use with skipPull=true so existing
   * files aren't pruned away before detect_hands runs.
   */
  selectedFiles?: string[];
  /**
   * FORM submissions the user wants clipped. We write a targeted list
   * file and run pull_form_submissions against ONLY those (so we don't
   * re-download every pending submission), then detect_hands processes
   * them via --files with their sanitized basenames.
   */
  selectedForms?: Array<{ driveFileId: string; fileName: string }>;
}): { started: boolean; reason?: string } {
  if (state.running) {
    return { started: false, reason: "already running" };
  }
  if (!fs.existsSync(pipelineRoot())) {
    return {
      started: false,
      reason: `pipeline folder not found: ${pipelineRoot()}`,
    };
  }

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.exitCode = null;
  state.log = [];
  state.step = "idle";

  void (async () => {
    try {
      // Before kicking off Python, write out the form-submission list
      // so pull_from_drive.py knows not to prune those files and
      // pull_form_submissions.py knows what to download.
      const { listPath } = await writeFormSubmissionList();

      if (!opts?.skipPull) {
        state.step = "pull_from_drive";
        const args: string[] = ["--keep-list", listPath];
        if (opts?.folderId) args.push("--folder", opts.folderId);
        const code = await runStep("pull_from_drive.py", args);
        if (code !== 0) {
          state.step = "error";
          state.exitCode = code;
          return;
        }

        // Pull form-submission videos (per-submission Drive folders the
        // folder scan can't reach). Step is independent of skipPull only
        // in spirit — if you skipped the Drive folder scan you probably
        // skipped form pulls too, so we gate on the same flag.
        state.step = "pull_form_submissions";
        const formCode = await runStep("pull_form_submissions.py", [listPath]);
        if (formCode !== 0) {
          state.step = "error";
          state.exitCode = formCode;
          return;
        }
      }

      // Targeted form-pull: when the user selected specific FORM rows,
      // download ONLY those (not every pending submission). Runs even
      // when skipPull=true, because the user explicitly asked for these
      // forms to be clipped and they likely aren't on disk yet.
      const safeForms = (opts?.selectedForms ?? []).filter(
        (f) =>
          typeof f.driveFileId === "string" &&
          typeof f.fileName === "string" &&
          f.fileName.length > 0,
      );
      if (safeForms.length > 0) {
        const targetedPath = path.join(
          pipelineRoot(),
          ".selected-form-files.txt",
        );
        try {
          const lines = safeForms
            .map(
              (f) =>
                `${f.driveFileId}\t${safeBasename(f.fileName)}`,
            )
            .join("\n");
          fs.writeFileSync(
            targetedPath,
            "# Targeted form-submission list (regenerated on every Clip-N click).\n" +
              "# Format: <driveFileId>\\t<sanitizedFileName>\n" +
              lines +
              "\n",
            "utf8",
          );
        } catch (e) {
          pushLog(
            `! could not write ${targetedPath}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
        state.step = "pull_form_submissions";
        const formCode = await runStep(
          "pull_form_submissions.py",
          [targetedPath],
        );
        if (formCode !== 0) {
          state.step = "error";
          state.exitCode = formCode;
          return;
        }
      }

      state.step = "detect_hands";
      // Path-traversal guard for selectedFiles. detect_hands.py also
      // validates, but we shouldn't pass anything sketchy to it.
      const detectArgs: string[] = [];
      const safeSelected = (opts?.selectedFiles ?? []).filter(
        (n) =>
          typeof n === "string" &&
          n.length > 0 &&
          !n.includes("/") &&
          !n.includes("\\") &&
          !n.includes(".."),
      );
      // Add the sanitized form filenames to the --files set so
      // detect_hands processes just those, alongside the raw selections.
      const safeFormNames = safeForms.map((f) => safeBasename(f.fileName));
      const combined = [...new Set([...safeSelected, ...safeFormNames])];
      if (combined.length > 0) {
        detectArgs.push("--files", ...combined);
      }
      const detectCode = await runStep("detect_hands.py", detectArgs);
      if (detectCode !== 0) {
        state.step = "error";
        state.exitCode = detectCode;
        return;
      }

      if (!opts?.skipUpload) {
        state.step = "upload_clips_to_drive";
        const uploadCode = await runStep(
          "upload_clips_to_drive.py",
          handoffFolderArgs(),
        );
        if (uploadCode !== 0) {
          state.step = "error";
          state.exitCode = uploadCode;
          return;
        }
      }

      state.step = "done";
      state.exitCode = 0;
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  })();

  return { started: true };
}

// -----------------------------------------------------------------------------
// Bulk delete
// -----------------------------------------------------------------------------

export type DeleteResult = {
  deleted: string[];
  failed: { name: string; error: string }[];
  /** Clips whose Drive copy was NOT touched — surfaced so the UI can warn. */
  driveCopyRemains: string[];
};

/**
 * Delete one or more clipped MP4s from disk + clean up pipeline.db rows.
 *
 * We do NOT touch the Drive copy (the file may have been uploaded to the
 * hand-off folder, owned by the user's OAuth identity which the service
 * account can't act on). The UI surfaces `driveCopyRemains` so the user
 * knows to delete from Drive separately if they want.
 */
export function deleteClips(names: string[]): DeleteResult {
  const result: DeleteResult = {
    deleted: [],
    failed: [],
    driveCopyRemains: [],
  };

  // First resolve and validate every name. Refuse path traversal — the same
  // guard resolveClipPath() applies. Names whose path can't be resolved
  // (already gone? bad chars?) go into `failed`.
  const resolved: { name: string; fullPath: string; clipId: string }[] = [];
  for (const raw of names) {
    const name = decodeURIComponent(raw);
    const full = resolveClipPath(name);
    if (!full) {
      result.failed.push({ name, error: "not-found-or-invalid-name" });
      continue;
    }
    resolved.push({
      name,
      fullPath: full,
      clipId: name.replace(/\.mp4$/i, ""),
    });
  }

  if (resolved.length === 0) return result;

  // Read drive_file_id for each clip BEFORE we delete, so we can tell the
  // user which ones still have a Drive copy lying around.
  const driveIds = new Map<string, string>();
  const dbRO = openDb();
  if (dbRO) {
    try {
      const stmt = dbRO.prepare(
        "SELECT clip_id, drive_file_id FROM clips WHERE clip_id = ?",
      );
      for (const r of resolved) {
        const row = stmt.get(r.clipId) as
          | { clip_id: string; drive_file_id: string | null }
          | undefined;
        if (row?.drive_file_id) driveIds.set(r.name, row.drive_file_id);
      }
    } catch {
      // Older DB without drive_file_id column; ignore.
    } finally {
      dbRO.close();
    }
  }

  // Delete files from disk.
  for (const r of resolved) {
    try {
      fs.unlinkSync(r.fullPath);
      result.deleted.push(r.name);
      if (driveIds.has(r.name)) result.driveCopyRemains.push(r.name);
    } catch (e) {
      result.failed.push({
        name: r.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Clean up DB rows for the successfully-deleted files (best-effort).
  if (result.deleted.length > 0) {
    const dbRW = openDbWritable();
    if (dbRW) {
      try {
        const del = dbRW.prepare("DELETE FROM clips WHERE clip_id = ?");
        const tx = dbRW.transaction((ids: string[]) => {
          for (const id of ids) del.run(id);
        });
        tx(result.deleted.map((n) => n.replace(/\.mp4$/i, "")));
      } catch {
        // DB cleanup is best-effort; the file delete already succeeded.
      } finally {
        dbRW.close();
      }
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// Bulk delete for the Unclipped pane (raw files in incoming/)
// -----------------------------------------------------------------------------

export type DeleteIncomingResult = {
  deleted: string[];
  failed: { name: string; error: string }[];
};

/**
 * Resolve a basename to an absolute path inside `incoming/`, refusing
 * path traversal. Used for both delete and clip-selected.
 */
export function resolveIncomingPath(name: string): string | null {
  if (!name) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  // Same charset we allow for clip filenames, but with .mov/.mp4/.avi/.mkv.
  if (!/^[\w.\-() ]+\.(?:mp4|mov|avi|mkv)$/i.test(name)) return null;
  const full = path.join(incomingDir(), name);
  if (!fs.existsSync(full)) return null;
  return full;
}

/**
 * Delete one or more raw videos from incoming/. There's no DB row to
 * clean up (raw files are pure filesystem state, unlike clipped files
 * which live in pipeline.db). Re-running the pull step will fetch them
 * back from Drive — that's a feature, not a bug, since users can re-
 * download anything they delete by mistake.
 */
export function deleteIncoming(names: string[]): DeleteIncomingResult {
  const result: DeleteIncomingResult = { deleted: [], failed: [] };
  for (const raw of names) {
    const name = decodeURIComponent(raw);
    const full = resolveIncomingPath(name);
    if (!full) {
      result.failed.push({ name, error: "not-found-or-invalid-name" });
      continue;
    }
    try {
      fs.unlinkSync(full);
      result.deleted.push(name);
    } catch (e) {
      result.failed.push({
        name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}

/** Best-effort cancel — SIGTERM the active child if one exists. */
export function cancelClippingRun(): boolean {
  if (!activeChild) return false;
  try {
    activeChild.kill("SIGTERM");
    pushLog("! cancel requested (SIGTERM)");
    return true;
  } catch {
    return false;
  }
}
