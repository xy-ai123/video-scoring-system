/**
 * Measure a video's duration from Drive, with four fallback paths.
 *
 * Extracted so the Drive-folder ingester (and anyone else) can do the same
 * end-to-end measurement that `scripts/backfillDurations.ts` does — without
 * having to import a script. The probes are pure functions of `driveFileId`;
 * we don't touch Prisma here.
 *
 *   1. Drive `videoMediaMetadata.durationMillis` — cheap, zero bytes
 *      downloaded. Drive populates this asynchronously after upload, so
 *      newly-uploaded multi-GB videos commonly return null.
 *   2. Head-stream probe — read up to 32 MB from the start of the file and
 *      look for `moov`. Wins for faststart-enabled MP4s.
 *   3. Tail-range probe — Drive ranged-GET of the last 32 MB; brute-force
 *      scan for `moov`. Wins for recorder-output .MOV files where moov sits
 *      at the end of the file.
 *   4. **ffprobe fallback** — download the full file to a temp path and
 *      invoke `ffprobe -show_entries format=duration`. Required for files
 *      Drive's transcoder never indexed AND whose container our cheap MP4
 *      parser can't read (HEVC/H.265 from iPhone, ProRes, weird MOV
 *      variants, etc.). Expensive — one full download per file — so we
 *      only reach this path when the three cheap probes all returned
 *      null. The DB stores the resulting durationSec, so subsequent
 *      sync runs short-circuit at the DB diff stage and never hit
 *      this code path again for that file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { downloadFile, getDriveClient } from "./drive.js";
import {
  parseMp4DurationFromStream,
  parseMp4DurationFromTailBuffer,
} from "./mp4Duration.js";
import { logger } from "../lib/logger.js";

const HEAD_PROBE_CAP_BYTES = 32 * 1024 * 1024;
const TAIL_PROBE_BYTES = 32 * 1024 * 1024;
// Maximum file size we'll download for ffprobe. Above this we give up
// (a 5 GB HEVC video would still be measurable but the bandwidth cost
// is hard to justify on every sync run). Tune via env if needed.
const FFPROBE_DOWNLOAD_CAP_BYTES = (() => {
  const raw = Number(process.env.FFPROBE_DOWNLOAD_CAP_GB);
  const gb = Number.isFinite(raw) && raw > 0 ? raw : 2; // default: 2 GB
  return gb * 1024 * 1024 * 1024;
})();

// Cooldown between ffprobe attempts for the SAME driveFileId. Backed by
// a JSON file under PIPELINE_ROOT so it persists across worker restarts
// and the dashboard's spawned syncs. Default: 24h. Keeps Sync Drive
// fast when the operator has structurally-corrupt files that can't be
// measured no matter how many times we ffprobe them (a re-upload to
// Drive is the actual fix). Files that succeed on ffprobe get their
// durationSec persisted to Postgres — the backfill loop won't pick
// them up again at all, so this cooldown only affects FAILED attempts
// in practice.
const FFPROBE_RETRY_INTERVAL_MS = (() => {
  const h = Number(process.env.FFPROBE_RETRY_HOURS);
  const hours = Number.isFinite(h) && h > 0 ? h : 24;
  return hours * 60 * 60 * 1000;
})();
const FFPROBE_ATTEMPTS_FILE = (() => {
  const root =
    process.env.ROBOT_PIPELINE_PATH ||
    path.join(os.homedir(), "robot-video-pipeline");
  return path.join(root, ".duration-ffprobe-attempts.json");
})();

type AttemptMap = Record<string, number>; // driveFileId -> unix ms

function loadFfprobeAttempts(): AttemptMap {
  try {
    const raw = fs.readFileSync(FFPROBE_ATTEMPTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Coerce values to numbers — defensive against hand-edited files.
      const out: AttemptMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        const n = Number(v);
        if (Number.isFinite(n)) out[k] = n;
      }
      return out;
    }
  } catch {
    // Missing file / parse error → treat as empty map.
  }
  return {};
}

function saveFfprobeAttempt(driveFileId: string): void {
  const map = loadFfprobeAttempts();
  map[driveFileId] = Date.now();
  try {
    fs.writeFileSync(
      FFPROBE_ATTEMPTS_FILE,
      JSON.stringify(map, null, 2),
      "utf8",
    );
  } catch {
    // If the pipeline root doesn't exist yet (test env / fresh checkout)
    // we silently skip persistence. Worst case: ffprobe re-runs on
    // every sync until the file becomes writable. Not a correctness bug.
  }
}

export type DurationSource = "metadata" | "bytes-head" | "bytes-tail" | "ffprobe";

export type DurationResult = {
  durationSec: number | null;
  source: DurationSource | null;
};

/**
 * Stream `driveFileId` to a temp file and run `ffprobe` against it to
 * extract `format.duration`. Returns null on any failure (ffprobe
 * missing, malformed output, file too big, download error). Cleans up
 * the tempfile in a `finally`.
 */
// Loose log type so we can accept whatever `logger.child(...)` returns at
// the call-site (its generic args differ between callers and aren't worth
// threading through here — pino's logger surface is the same either way).
type LooseLogger = {
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
};

async function measureViaFfprobe(
  driveFileId: string,
  fileSize: number | null,
  log: LooseLogger,
): Promise<number | null> {
  // Cooldown short-circuit. If we tried this driveFileId within the
  // last FFPROBE_RETRY_INTERVAL_MS, skip the (expensive) download +
  // ffprobe pass. The cheap probes upstream still run on every sync,
  // so Drive's videoMediaMetadata.durationMillis will get picked up
  // immediately if it ever populates — only the slow ffprobe path
  // honours the cooldown.
  const attempts = loadFfprobeAttempts();
  const last = attempts[driveFileId];
  if (last != null && Date.now() - last < FFPROBE_RETRY_INTERVAL_MS) {
    const remainingHr = (
      (FFPROBE_RETRY_INTERVAL_MS - (Date.now() - last)) /
      (60 * 60 * 1000)
    ).toFixed(1);
    log.info(
      { lastAttempt: new Date(last).toISOString(), remainingHr },
      "ffprobe fallback: skipping (cooldown active)",
    );
    return null;
  }

  if (fileSize != null && fileSize > FFPROBE_DOWNLOAD_CAP_BYTES) {
    log.warn(
      { fileSize, cap: FFPROBE_DOWNLOAD_CAP_BYTES },
      "ffprobe fallback: file exceeds size cap, skipping",
    );
    // Mark the attempt so the next sync within the cooldown also
    // skips — large files take long even just to size-check via Drive
    // API, so a near-instant short-circuit is worthwhile.
    saveFfprobeAttempt(driveFileId);
    return null;
  }

  // Random tempfile to avoid collisions when measurements run in
  // parallel. Suffix is just informational — ffprobe sniffs format.
  const tmp = path.join(
    os.tmpdir(),
    `drive-dur-${driveFileId}-${Date.now()}.bin`,
  );
  try {
    // 1. Download the entire file to tempfile.
    const dl = await downloadFile(driveFileId);
    await pipeline(dl.stream, fs.createWriteStream(tmp));

    // 2. Run ffprobe and parse seconds.
    const sec = await new Promise<number | null>((resolve) => {
      const child = spawn(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          tmp,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.on("error", (err) => {
        log.warn(
          { errMessage: err.message },
          "ffprobe fallback: spawn failed (is ffprobe on PATH?)",
        );
        resolve(null);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          log.warn(
            { code, stderr: stderr.slice(0, 200) },
            "ffprobe fallback: exited non-zero",
          );
          resolve(null);
          return;
        }
        const n = Number(stdout.trim());
        if (Number.isFinite(n) && n > 0) {
          resolve(n);
        } else {
          log.warn(
            { stdout: stdout.slice(0, 200) },
            "ffprobe fallback: unparseable duration",
          );
          resolve(null);
        }
      });
    });
    return sec;
  } catch (err) {
    log.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      "ffprobe fallback: download or pipeline failed",
    );
    return null;
  } finally {
    // Record the attempt regardless of outcome. Success records too
    // for completeness — the row's durationSec will be set so the
    // backfill loop won't pick it up again, but if anyone ever
    // manually clears durationSec without clearing this map, the
    // cooldown will still protect them.
    saveFfprobeAttempt(driveFileId);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tempfile might not exist if download failed early — fine.
    }
  }
}

async function downloadTailBytes(
  driveFileId: string,
  totalSize: number,
  tailBytes: number,
): Promise<Buffer> {
  const start = Math.max(0, totalSize - tailBytes);
  const end = totalSize - 1;
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId: driveFileId, alt: "media", supportsAllDrives: true },
    {
      headers: { Range: `bytes=${start}-${end}` },
      responseType: "arraybuffer",
    },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

export async function measureDriveVideoDuration(
  driveFileId: string,
): Promise<DurationResult> {
  const log = logger.child({ driveFileId, op: "measureDriveVideoDuration" });
  const drive = getDriveClient();

  // 1. Cheap metadata path. Also grab file size for the tail probe below.
  let fileSize: number | null = null;
  try {
    const meta = await drive.files.get({
      fileId: driveFileId,
      fields: "id,size,videoMediaMetadata",
      supportsAllDrives: true,
    });
    const ms = meta.data.videoMediaMetadata?.durationMillis;
    if (ms != null) {
      const n = Number(ms);
      if (Number.isFinite(n)) {
        return { durationSec: n / 1000, source: "metadata" };
      }
    }
    if (meta.data.size) {
      const sz = Number(meta.data.size);
      if (Number.isFinite(sz)) fileSize = sz;
    }
  } catch (err) {
    log.debug(
      { errMessage: err instanceof Error ? err.message : String(err) },
      "metadata fetch failed; falling through to byte probes",
    );
  }

  // 2. Head-of-file streaming probe.
  try {
    const dl = await downloadFile(driveFileId);
    const sec = await parseMp4DurationFromStream(
      dl.stream,
      HEAD_PROBE_CAP_BYTES,
    );
    if (sec != null) return { durationSec: sec, source: "bytes-head" };
    (dl.stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  } catch (err) {
    log.debug(
      { errMessage: err instanceof Error ? err.message : String(err) },
      "head probe failed",
    );
  }

  // 3. Tail-range probe. Requires knowing the file size; if we never got
  //    it from metadata, fetch it now in a tiny call rather than skip.
  if (fileSize == null) {
    try {
      const meta = await drive.files.get({
        fileId: driveFileId,
        fields: "size",
        supportsAllDrives: true,
      });
      if (meta.data.size) {
        const sz = Number(meta.data.size);
        if (Number.isFinite(sz)) fileSize = sz;
      }
    } catch {
      /* if even this fails we'll just return null below */
    }
  }
  if (fileSize != null && fileSize > 0) {
    try {
      const tailLen = Math.min(TAIL_PROBE_BYTES, fileSize);
      const buf = await downloadTailBytes(driveFileId, fileSize, tailLen);
      const sec = parseMp4DurationFromTailBuffer(buf);
      if (sec != null) return { durationSec: sec, source: "bytes-tail" };
    } catch (err) {
      log.debug(
        { errMessage: err instanceof Error ? err.message : String(err) },
        "tail probe failed",
      );
    }
  }

  // 4. ffprobe fallback — the expensive option. We only get here when
  //    Drive metadata is empty AND neither byte-probe found a moov
  //    atom. Typical cause: file is HEVC/H.265 inside an MP4 container
  //    (iPhone default), or a recorder-output MOV the cheap parser
  //    can't read. Cost: one full download per file. The result is
  //    persisted to DB so we only pay it once per file (the sync's
  //    diff loop short-circuits on rows whose durationSec is non-null).
  log.info({}, "all cheap probes failed; trying ffprobe fallback");
  const ffSec = await measureViaFfprobe(driveFileId, fileSize, log);
  if (ffSec != null) return { durationSec: ffSec, source: "ffprobe" };

  return { durationSec: null, source: null };
}
