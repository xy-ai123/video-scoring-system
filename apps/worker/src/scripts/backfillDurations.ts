/**
 * One-off backfill: re-measure every VideoFile's video duration straight from
 * Drive and write it to VideoFile.durationSec.
 *
 * Measurement strategy (per row):
 *   1. Ask Drive for `videoMediaMetadata.durationMillis` (cheap, no download).
 *   2. If Drive hasn't populated that yet, download the file bytes from Drive
 *      and parse the MP4 `moov` → `mvhd` atom locally. This is what the user
 *      means by "get the video from drive and calculate again" — the bytes
 *      come from Drive and we compute the duration ourselves.
 *
 * Runs against ALL rows, regardless of scoringStatus — so PENDING, FAILED,
 * IN_PROGRESS, and COMPLETED files are all updated. By default rows that
 * already have a durationSec value are SKIPPED; pass `--force` to re-probe.
 *
 * Usage (from the worker package dir, i.e. apps/worker):
 *   pnpm exec tsx src/scripts/backfillDurations.ts
 *   pnpm exec tsx src/scripts/backfillDurations.ts --force
 *   pnpm exec tsx src/scripts/backfillDurations.ts --concurrency=8
 *   pnpm exec tsx src/scripts/backfillDurations.ts --metadata-only
 *
 * Requires the same env the worker uses (DATABASE_URL, GOOGLE_SERVICE_ACCOUNT_JSON).
 */

// Load .env before any module that reads process.env (Prisma, env.ts, Drive).
// Mirrors the worker's index.ts: cwd is apps/worker so this picks up
// apps/worker/.env; the project-root .env is also loaded as a fallback.
import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: "../../.env", override: false });

import { prisma } from "@vss/db";
import { downloadFile, getDriveClient } from "../services/drive.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import {
  parseMp4DurationFromStream,
  parseMp4DurationFromTailBuffer,
} from "../services/mp4Duration.js";

/** Last-N-bytes ranged GET from Drive. Used to find the `moov` atom in
 *  smartphone recordings that don't have faststart — the atom sits at the
 *  end of the file, so downloading the tail is dramatically cheaper than
 *  streaming the whole multi-GB body. */
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
  // googleapis returns the body as the configured type via res.data.
  return Buffer.from(res.data as ArrayBuffer);
}

type Args = {
  force: boolean;
  concurrency: number;
  /** When the live Drive metadata fetch fails (404 / 403 / etc.), fall back
   *  to a deterministic mock duration derived from the driveFileId. Only
   *  intended for dev databases whose rows were created in DRIVE_MOCK=true
   *  mode and now reference Drive files the service account can't see. */
  mockOnError: boolean;
  /** If true, skip the byte-download fallback when Drive metadata is null.
   *  Faster but leaves rows whose metadata Drive never extracted as null. */
  metadataOnly: boolean;
};

function parseArgs(argv: string[]): Args {
  let force = false;
  let concurrency = 4;
  let mockOnError = false;
  let metadataOnly = false;
  for (const a of argv) {
    if (a === "--force") force = true;
    if (a === "--mock-on-error") mockOnError = true;
    if (a === "--metadata-only") metadataOnly = true;
    const m = a.match(/^--concurrency=(\d+)$/);
    if (m) concurrency = Math.max(1, Math.min(16, Number(m[1])));
  }
  return { force, concurrency, mockOnError, metadataOnly };
}

function mockDurationFor(driveFileId: string): number {
  const seed = [...driveFileId].reduce(
    (a, c) => (a * 31 + c.charCodeAt(0)) >>> 0,
    11,
  );
  return 5 + (seed % 300);
}

type Row = {
  id: string;
  driveFileId: string;
  fileName: string;
  durationSec: number | null;
};

type Source = "metadata" | "bytes-head" | "bytes-tail" | "mock";

type FetchResult = {
  durationSec: number | null;
  source: Source | null;
};

// Cap the head-of-file probe small so we don't waste bandwidth on huge files
// whose moov is at the end. 32 MB is plenty for faststart MP4s (moov is
// usually well under 1 MB and lives near the front).
const HEAD_PROBE_CAP_BYTES = 32 * 1024 * 1024;
const TAIL_PROBE_BYTES = 32 * 1024 * 1024;

async function fetchDurationSec(
  driveFileId: string,
  metadataOnly: boolean,
): Promise<FetchResult> {
  if (env.DRIVE_MOCK) {
    return { durationSec: mockDurationFor(driveFileId), source: "mock" };
  }

  // 1. Cheap path: ask Drive what it already extracted. Also grab the file
  //    size so we can decide whether/how to do a tail probe if metadata is
  //    missing — Drive's metadata extraction is async, especially for big
  //    smartphone recordings, so newly-uploaded multi-GB videos often hit
  //    this branch with vmm = null.
  const drive = getDriveClient();
  const meta = await drive.files.get({
    fileId: driveFileId,
    fields: "id,size,videoMediaMetadata",
    supportsAllDrives: true,
  });
  const ms = meta.data.videoMediaMetadata?.durationMillis;
  if (ms != null) {
    const n = Number(ms);
    if (Number.isFinite(n)) return { durationSec: n / 1000, source: "metadata" };
  }

  if (metadataOnly) return { durationSec: null, source: null };

  const fileSize = meta.data.size ? Number(meta.data.size) : null;

  // 2. Cheap byte-probe: stream the head of the file (capped). Works for
  //    faststart-enabled MP4s where moov sits near the start.
  try {
    const dl = await downloadFile(driveFileId);
    const sec = await parseMp4DurationFromStream(dl.stream, HEAD_PROBE_CAP_BYTES);
    if (sec != null) return { durationSec: sec, source: "bytes-head" };
    // Best-effort close: try to free the underlying connection if the stream
    // still emits. The googleapis stream usually ends when we stop consuming.
    (dl.stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  } catch (err) {
    // Don't swallow auth/quota errors silently — let the caller log + fall back.
    const message = err instanceof Error ? err.message : String(err);
    logger.debug({ driveFileId, errMessage: message }, "head probe failed");
  }

  // 3. Tail-range probe: for recorder-output MP4s (moov at end of file),
  //    fetch just the last 32 MB via Drive's ranged-GET and brute-force scan
  //    the tail buffer for the `moov` 4cc. Only run when we know the file
  //    size — without it we can't form a Range header.
  if (fileSize != null && fileSize > 0) {
    try {
      const tailLen = Math.min(TAIL_PROBE_BYTES, fileSize);
      const buf = await downloadTailBytes(driveFileId, fileSize, tailLen);
      const sec = parseMp4DurationFromTailBuffer(buf);
      if (sec != null) return { durationSec: sec, source: "bytes-tail" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug({ driveFileId, errMessage: message }, "tail probe failed");
    }
  }

  return { durationSec: null, source: null };
}

type Outcome =
  | "updated-metadata"
  | "updated-bytes-head"
  | "updated-bytes-tail"
  | "updated-mock"
  | "updated-mock-fallback"
  | "unchanged"
  | "no-duration"
  | "error";

async function processOne(
  row: Row,
  metadataOnly: boolean,
  mockOnError: boolean,
): Promise<Outcome> {
  let result: FetchResult | null = null;
  try {
    result = await fetchDurationSec(row.driveFileId, metadataOnly);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      (err as { code?: number; response?: { status?: number } })?.code ??
      (err as { response?: { status?: number } })?.response?.status;
    if (mockOnError) {
      result = { durationSec: mockDurationFor(row.driveFileId), source: "mock" };
      logger.warn(
        {
          fileId: row.id,
          driveFileId: row.driveFileId,
          fileName: row.fileName,
          status,
          errMessage: message,
          mockDurationSec: result.durationSec,
        },
        "drive fetch failed; using mock fallback (--mock-on-error)",
      );
    } else {
      logger.error(
        {
          fileId: row.id,
          driveFileId: row.driveFileId,
          fileName: row.fileName,
          status,
          errMessage: message,
        },
        "backfill: drive fetch failed",
      );
      return "error";
    }
  }

  const { durationSec, source } = result;

  if (durationSec == null) {
    logger.warn(
      { fileId: row.id, driveFileId: row.driveFileId, fileName: row.fileName },
      "no usable duration from drive (metadata empty and bytes-probe couldn't parse) — leaving durationSec untouched",
    );
    return "no-duration";
  }

  if (
    row.durationSec != null &&
    Math.abs(row.durationSec - durationSec) < 0.01
  ) {
    logger.info(
      {
        fileId: row.id,
        driveFileId: row.driveFileId,
        fileName: row.fileName,
        durationSec,
        source,
      },
      "durationSec unchanged",
    );
    return "unchanged";
  }

  await prisma.videoFile.update({
    where: { id: row.id },
    data: { durationSec },
  });
  logger.info(
    {
      fileId: row.id,
      driveFileId: row.driveFileId,
      fileName: row.fileName,
      durationSec,
      previous: row.durationSec,
      source,
    },
    "durationSec updated",
  );
  if (source === "metadata") return "updated-metadata";
  if (source === "bytes-head") return "updated-bytes-head";
  if (source === "bytes-tail") return "updated-bytes-tail";
  // `mock` source comes from either DRIVE_MOCK env or the --mock-on-error
  // fallback. Distinguish them so the summary tells you which path was used.
  return env.DRIVE_MOCK ? "updated-mock" : "updated-mock-fallback";
}

async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

async function main() {
  const { force, concurrency, mockOnError, metadataOnly } = parseArgs(
    process.argv.slice(2),
  );

  const where = force ? {} : { durationSec: null };
  const rows = (await prisma.videoFile.findMany({
    where,
    select: {
      id: true,
      driveFileId: true,
      fileName: true,
      durationSec: true,
    },
    orderBy: { createdAt: "asc" },
  })) as Row[];

  logger.info(
    {
      total: rows.length,
      force,
      concurrency,
      mockOnError,
      metadataOnly,
      driveMock: env.DRIVE_MOCK,
    },
    "backfillDurations: starting",
  );

  if (rows.length === 0) {
    logger.info("backfillDurations: nothing to do");
    await prisma.$disconnect();
    return;
  }

  const outcomes = await runPool(rows, concurrency, (row) =>
    processOne(row, metadataOnly, mockOnError),
  );

  const summary = outcomes.reduce(
    (acc, o) => {
      acc[o] = (acc[o] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  logger.info(summary, "backfillDurations: done");

  await prisma.$disconnect();
}

main().catch(async (err) => {
  logger.error({ err }, "backfillDurations: fatal");
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
