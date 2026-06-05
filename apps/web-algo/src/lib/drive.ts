/**
 * Minimal read-only Drive client for the hand-off folder.
 * Mirrors apps/worker/src/services/drive.ts but only the bits we need
 * (list files in one folder + a small mock fallback).
 */

import { google, type drive_v3 } from "googleapis";
import { JWT } from "google-auth-library";
import { env } from "./env";

let cached: drive_v3.Drive | undefined;

function decodeServiceAccount() {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  let jsonText: string;
  try {
    jsonText = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid base64");
  }
  if (!jsonText.trim().startsWith("{")) jsonText = raw;
  const sa = JSON.parse(jsonText) as {
    client_email: string;
    private_key: string;
  };
  if (!sa.client_email || !sa.private_key) {
    throw new Error("service account JSON missing client_email/private_key");
  }
  return sa;
}

export function getDriveClient(): drive_v3.Drive {
  if (cached) return cached;
  const sa = decodeServiceAccount();
  const auth = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  cached = google.drive({ version: "v3", auth });
  return cached;
}

export type HandoffFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  modifiedTime: string | null;
  webViewLink: string;
  durationSec: number | null;
};

export async function listHandoffFolder(
  folderId: string,
): Promise<HandoffFile[]> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    // Fall back to a small mock list so the dashboard renders even without
    // credentials wired up.
    return [
      {
        id: "mock-1",
        name: "mock-clip-001.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1_234_567,
        modifiedTime: new Date().toISOString(),
        webViewLink: "https://drive.google.com/",
        durationSec: 12.4,
      },
    ];
  }
  const drive = getDriveClient();
  const out: HandoffFile[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const res: { data: drive_v3.Schema$FileList } = await drive.files.list({
      q:
        `'${folderId}' in parents and trashed = false ` +
        "and (mimeType contains 'video/' or name contains '.mp4')",
      fields:
        "nextPageToken, files(id,name,mimeType,size,modifiedTime,webViewLink,videoMediaMetadata)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      const dms = f.videoMediaMetadata?.durationMillis;
      const durationSec =
        dms != null && Number.isFinite(Number(dms)) ? Number(dms) / 1000 : null;
      out.push({
        id: f.id ?? "",
        name: f.name ?? "(unnamed)",
        mimeType: f.mimeType ?? "application/octet-stream",
        sizeBytes: f.size ? Number(f.size) : null,
        modifiedTime: f.modifiedTime ?? null,
        webViewLink:
          f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
        durationSec,
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}
