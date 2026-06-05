/**
 * Drive sync bridge — spawns the worker's `syncFromSharedDrive.ts` so
 * the admin can pull in new / renamed / removed Drive files without
 * dropping to a terminal.
 *
 * The script already exists in apps/worker/src/scripts and handles three
 * things per run, idempotently:
 *   - New videos in any folder shared with the service account → new
 *     Submission rows.
 *   - Renamed videos → existing rows updated in place (matched by
 *     driveFileId).
 *   - Files removed from Drive → soft-delete on the matching Submission.
 *
 * Why a separate process instead of importing the ingest functions in
 * the web app? They live in apps/worker and pull in BullMQ, ZIP
 * extraction, and the full Drive client — bloat the dashboard doesn't
 * need. Spawning keeps the web bundle small and matches the existing
 * clipping flow (clipping.ts also spawns a worker process).
 *
 * Concurrency: only one sync runs at a time. A second click while one
 * is in flight returns `{ started: false, reason: "already_running" }`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { invalidateDriveMains } from "./driveMains";

/**
 * Repo root. We prefer to derive it from `process.cwd()` (which is the
 * `apps/web` directory under both `pnpm dev` and `pnpm start`) rather
 * than `__dirname` — Next.js bundles route handlers into `.next/server/`
 * and `__dirname` would point there, not at the source tree.
 *
 * Env override is honored for unusual deployments (e.g. running the
 * built `next start` from a different cwd, or a Docker layout).
 */
function repoRoot(): string {
  const fromEnv = process.env.MONOREPO_ROOT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  // process.cwd() is .../apps/web → go up two levels to repo root.
  return path.resolve(process.cwd(), "..", "..");
}

function workerDir(): string {
  return path.join(repoRoot(), "apps", "worker");
}

function syncScript(): string {
  return path.join(workerDir(), "src", "scripts", "syncFromSharedDrive.ts");
}

function tsxBin(): string {
  // pnpm hoists per-package, so tsx lives in the worker's node_modules.
  return path.join(workerDir(), "node_modules", ".bin", "tsx");
}

export type DriveSyncState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  log: string[];
  /** Parsed totals from the final `syncFromSharedDrive: complete` line. */
  result: DriveSyncResult | null;
};

export type DriveSyncResult = {
  scanned: number;
  ingested: number;
  durationsBackfilled: number;
  softDeleted: number;
  errors: number;
};

const MAX_LOG_LINES = 200;
const state: DriveSyncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  log: [],
  result: null,
};
let activeChild: ChildProcess | null = null;

function pushLog(line: string): void {
  state.log.push(line);
  if (state.log.length > MAX_LOG_LINES) {
    state.log.splice(0, state.log.length - MAX_LOG_LINES);
  }
}

/**
 * Best-effort parse of the rawTotals object out of the pino log line
 * emitted right before the script exits. pino-pretty formats the line
 * with timestamp + ANSI colors + JSON tail, e.g.
 *
 *   [11:21:19] INFO: syncFromSharedDrive: complete
 *     {"service":"worker","rawTotals":{"foldersWalked":39,...},...}
 *
 * (with ANSI escape codes around the level and braces). We strip
 * escapes, find the first `{` after "complete", and JSON.parse from
 * there to the end. If anything fails we just leave `result` null —
 * the operator can still scroll the raw log.
 */
function tryParseResult(log: string[]): DriveSyncResult | null {
  // ANSI escape sequences pino-pretty injects for color.
  const ANSI = /\x1b\[[0-9;]*m/g;
  for (let i = log.length - 1; i >= 0; i--) {
    const raw = log[i];
    if (!raw || !raw.includes("syncFromSharedDrive: complete")) continue;
    const stripped = raw.replace(ANSI, "");
    // Find the first { after the "complete" marker — that's the start
    // of the JSON payload pino-pretty appended.
    const markerIdx = stripped.indexOf("syncFromSharedDrive: complete");
    const braceIdx = stripped.indexOf("{", markerIdx);
    if (braceIdx < 0) continue;
    const jsonText = stripped.slice(braceIdx);
    try {
      const obj = JSON.parse(jsonText);
      const t = obj?.rawTotals ?? obj?.result?.rawTotals;
      // The script's `complete` payload now also includes zipSummary
      // (with its own soft-deleted counter for trashed ZIP archives).
      // We pool both numbers so the dashboard's "-N removed" chip
      // reflects every kind of disappearance, not just raw videos.
      const z = obj?.zipSummary ?? obj?.result?.zipSummary;
      if (t && typeof t === "object") {
        const rawSoft = Number(t.softDeleted ?? 0);
        const zipSoft = z && typeof z === "object" ? Number(z.softDeleted ?? 0) : 0;
        const zipIngested =
          z && typeof z === "object" ? Number(z.videosIngested ?? 0) : 0;
        const zipErrors = z && typeof z === "object" ? Number(z.errors ?? 0) : 0;
        return {
          scanned: Number(t.scanned ?? 0),
          ingested: Number(t.ingested ?? 0) + zipIngested,
          durationsBackfilled: Number(t.durationsBackfilled ?? 0),
          softDeleted: rawSoft + zipSoft,
          errors: Number(t.errors ?? 0) + zipErrors,
        };
      }
    } catch {
      // Malformed line — keep scanning earlier ones in case there's
      // another candidate.
    }
  }
  return null;
}

export function getDriveSyncState(): DriveSyncState {
  return { ...state, log: state.log.slice() };
}

export function startDriveSync():
  | { started: true }
  | { started: false; reason: string } {
  if (state.running) return { started: false, reason: "already_running" };
  const script = syncScript();
  if (!fs.existsSync(script)) {
    return { started: false, reason: "script_missing" };
  }
  const tsx = tsxBin();
  if (!fs.existsSync(tsx)) {
    return { started: false, reason: "tsx_missing" };
  }

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.exitCode = null;
  state.result = null;
  state.log = [];
  pushLog(`$ tsx ${path.relative(repoRoot(), script)}`);

  const child = spawn(tsx, [script], {
    cwd: workerDir(),
    env: {
      ...process.env,
      // Force unbuffered stdout — without this pino can hold the
      // "complete" line in a buffer past close, and we miss the result
      // parse.
      NODE_NO_WARNINGS: "1",
    },
  });
  activeChild = child;

  // BullMQ + Prisma sometimes hold the event loop alive for tens of
  // seconds after the script's main work is done — we'd rather show the
  // user "complete" the moment the work is done than wait for the
  // process to actually exit. So we mark done-on-log-line *and* on
  // process close, whichever comes first.
  function markDoneFromLog(): void {
    if (!state.running) return;
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.result = tryParseResult(state.log);
    // Invalidate the cached folder-name → main-name mapping. A sync
    // run can introduce brand-new top-level shared folders (e.g. user
    // gets access to "Vietnam Phase 2"); without this, the dashboard
    // wouldn't show that main as a chip / column value for up to
    // 5 minutes (the TTL). Cheap to nuke — next /admin render pays a
    // ~3s rebuild and caches again.
    invalidateDriveMains();
    // Kill the process so it doesn't sit around eating a Redis
    // connection. Its meaningful work is already on disk.
    if (activeChild && !activeChild.killed) {
      try {
        activeChild.kill("SIGTERM");
      } catch {
        // Ignore — close handler will fire on its own.
      }
    }
  }

  const onLine = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) pushLog(line);
      // Heuristic: the script's pino "complete" line signals that all
      // ingest work is durable in Postgres. Anything after that is
      // teardown the user doesn't need to wait for.
      if (line.includes("syncFromSharedDrive: complete")) {
        markDoneFromLog();
      }
    }
  };
  child.stdout?.on("data", onLine);
  child.stderr?.on("data", onLine);

  child.on("close", (code) => {
    pushLog(`-> exit ${code ?? -1}`);
    // If we already marked done from a log line, keep that timestamp
    // and result; only fill in the exit code.
    if (state.running) {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.result = tryParseResult(state.log);
    }
    state.exitCode = code ?? -1;
    activeChild = null;
  });
  child.on("error", (err) => {
    pushLog(`! spawn error: ${err.message}`);
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.exitCode = -1;
    activeChild = null;
  });

  return { started: true };
}
