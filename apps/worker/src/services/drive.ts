import { google, type drive_v3 } from "googleapis";
import { JWT } from "google-auth-library";
import { Readable } from "node:stream";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

let cachedClient: drive_v3.Drive | undefined;

function decodeServiceAccount(): {
  client_email: string;
  private_key: string;
  project_id: string;
} {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let jsonText: string;
  try {
    jsonText = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid base64");
  }
  // Some operators paste raw JSON instead. Tolerate that too.
  if (!jsonText.trim().startsWith("{")) {
    jsonText = raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON did not decode to JSON. Did you base64-encode the key file?",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("client_email" in parsed) ||
    !("private_key" in parsed)
  ) {
    throw new Error("Service account JSON missing client_email/private_key");
  }
  // We assert the relevant fields exist; service account JSON is well-known.
  const sa = parsed as {
    client_email: string;
    private_key: string;
    project_id: string;
  };
  return sa;
}

export function getDriveClient(): drive_v3.Drive {
  if (cachedClient) return cachedClient;
  const sa = decodeServiceAccount();
  const auth = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  cachedClient = google.drive({ version: "v3", auth });
  return cachedClient;
}

/** Sleep helper. */
function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export type DriveDownload = {
  stream: NodeJS.ReadableStream;
  mimeType: string;
  size: number | null;
  fileName: string;
  /** Video duration in seconds, if Drive's videoMediaMetadata is populated.
   *  Drive returns durationMillis as a string for video MIME types after it
   *  finishes background metadata extraction; null for non-video files or
   *  newly-uploaded files Drive hasn't processed yet. */
  durationSec: number | null;
};

/**
 * Download a Drive file as a stream. Honors 429/5xx with bounded retries
 * and Retry-After-style backoff.
 */
export async function downloadFile(
  fileId: string,
  opts: { maxAttempts?: number } = {},
): Promise<DriveDownload> {
  if (env.DRIVE_MOCK) {
    logger.info({ fileId, mock: true }, "drive mock download");
    const buf = Buffer.alloc(1024, 0);
    // Deterministic-but-varied mock duration so the dashboard total moves as
    // submissions arrive. Hash the fileId to pick something in [5, 305) seconds.
    const seed = [...fileId].reduce(
      (a, c) => (a * 31 + c.charCodeAt(0)) >>> 0,
      11,
    );
    const durationSec = 5 + (seed % 300);
    return {
      stream: Readable.from(buf),
      mimeType: "video/mp4",
      size: 1024,
      fileName: "mock-video.mp4",
      durationSec,
    };
  }

  const drive = getDriveClient();
  const maxAttempts = opts.maxAttempts ?? 4;

  // Fetch metadata first for mime/size/name reporting. videoMediaMetadata is
  // populated by Drive's background pipeline for video MIME types and carries
  // durationMillis (as a string).
  const meta = await drive.files.get({
    fileId,
    fields: "id,name,mimeType,size,videoMediaMetadata",
    supportsAllDrives: true,
  });
  const fileName = meta.data.name ?? fileId;
  const mimeType = meta.data.mimeType ?? "application/octet-stream";
  const size = meta.data.size ? Number(meta.data.size) : null;
  const durationMillisRaw = meta.data.videoMediaMetadata?.durationMillis;
  const durationMillis =
    durationMillisRaw != null ? Number(durationMillisRaw) : null;
  const durationSec =
    durationMillis != null && Number.isFinite(durationMillis)
      ? durationMillis / 1000
      : null;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await drive.files.get(
        {
          fileId,
          alt: "media",
          supportsAllDrives: true,
        },
        { responseType: "stream" },
      );
      // res.data is a Node Readable stream when responseType=stream.
      return {
        stream: res.data as unknown as NodeJS.ReadableStream,
        mimeType,
        size,
        fileName,
        durationSec,
      };
    } catch (err: unknown) {
      lastErr = err;
      // Look for status code on AxiosError-like errors from googleapis.
      const status =
        (err as { code?: number; response?: { status?: number } })?.code ??
        (err as { response?: { status?: number } })?.response?.status;
      const retriable =
        status === 429 || (typeof status === "number" && status >= 500);

      if (!retriable || attempt === maxAttempts) {
        logger.error(
          { err, fileId, status, attempt },
          "drive download failed (final)",
        );
        throw err;
      }

      const retryAfterHeader =
        (err as { response?: { headers?: Record<string, string> } })
          ?.response?.headers?.["retry-after"];
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : Math.min(30_000, 2 ** attempt * 500);

      logger.warn(
        { fileId, status, attempt, retryAfterMs },
        "drive download retrying",
      );
      await sleep(retryAfterMs);
    }
  }

  // Should be unreachable due to throw above.
  throw lastErr instanceof Error
    ? lastErr
    : new Error("drive download failed");
}
