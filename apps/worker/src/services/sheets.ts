/**
 * Google Sheets append for the decision log.
 *
 * Authenticates with the same service account JSON used by Drive (configured
 * via `GOOGLE_SERVICE_ACCOUNT_JSON`). Requires:
 *   1. Sheets API enabled on the service account's GCP project
 *   2. The target sheet shared with the service account email as Editor
 *      (Viewer is insufficient because we're writing)
 *
 * Each call appends one row to the configured sheet. Columns (must match the
 * sheet's header row):
 *   timestamp_iso | submitter_email | status | overall | clarity | engagement | submission_id
 */

import { google, type sheets_v4 } from "googleapis";
import { JWT } from "google-auth-library";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

let cachedClient: sheets_v4.Sheets | undefined;

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
  if (!jsonText.trim().startsWith("{")) {
    jsonText = raw;
  }
  return JSON.parse(jsonText) as {
    client_email: string;
    private_key: string;
    project_id: string;
  };
}

function getSheetsClient(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient;
  const sa = decodeServiceAccount();
  const auth = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

export type DecisionRowInput = {
  email: string;
  /** Kept on the input for forward-compat, but not currently written to the
   *  sheet (the user's sheet has no Category column). */
  category: string;
  /** "SCORED" covers drive-ingested submissions that have been auto-scored
   *  but haven't received an admin decision yet — those are logged by the
   *  drive-folder watcher. "APPROVED" / "REJECTED" come from the existing
   *  admin-decision flow in notifySubmitter.ts. */
  status: "APPROVED" | "REJECTED" | "SCORED";
  overall: number;
  clarity: number;
  engagement: number;
  submissionId: string;
};

/**
 * Build the row that gets written. Pulled out so it's unit-testable without
 * touching the network.
 *
 * Columns: timestamp | email | status | overall | clarity | engagement | submission_id
 * (Matches the user's "Score Record" sheet header row exactly.)
 */
export function buildDecisionRow(input: DecisionRowInput): string[] {
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "");
  // Protect against CSV/Sheets formula injection: prefix any cell that starts
  // with =, +, -, @, tab, or CR with a single quote so Sheets treats it as
  // literal text. Submitter email is attacker-controlled — Zod's email regex
  // doesn't block leading "=".
  const safe = (v: string) =>
    /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  // Date-only stamp ("5/14/2026"), matching the historical rows the user has
  // in the sheet. Uses the worker host's local timezone — running in the
  // user's SGT environment, that produces the same date Sheets would show.
  // Sheets parses this as a Date because the appender uses USER_ENTERED.
  const dateOnly = new Date().toLocaleDateString("en-US");
  return [
    dateOnly,
    safe(input.email),
    input.status,
    fmt(input.overall),
    fmt(input.clarity),
    fmt(input.engagement),
    input.submissionId,
  ];
}

/**
 * Append one row to the configured sheet. Returns the appended range string.
 * Throws on any underlying error.
 */
export async function appendDecisionRow(
  input: DecisionRowInput,
): Promise<string> {
  if (!env.SHEET_ID) {
    throw new Error("SHEET_ID is not set");
  }
  const sheets = getSheetsClient();
  const values = [buildDecisionRow(input)];
  // Target a specific tab when SHEET_TAB is set. Without it, the API defaults
  // to the FIRST tab in the spreadsheet — which is often "Form Responses 1"
  // when the spreadsheet was originally Forms-linked, NOT the tab you see.
  // Tab names with spaces must be wrapped in single quotes per A1 notation.
  const tab = env.SHEET_TAB ? env.SHEET_TAB.trim() : "";
  const tabPrefix = tab
    ? (/[\s']/.test(tab) ? `'${tab.replace(/'/g, "''")}'` : tab) + "!"
    : "";
  const range = `${tabPrefix}A:G`;
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: env.SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
  const updated = res.data.updates?.updatedRange ?? "(unknown)";
  logger.info(
    {
      submissionId: input.submissionId,
      sheetId: env.SHEET_ID,
      updatedRange: updated,
    },
    "decision row appended to sheet",
  );
  return updated;
}

/**
 * List the tab names in the configured spreadsheet. Useful for debugging
 * "wrong tab targeted" issues — call this and log the result so the operator
 * can pick the right value for SHEET_TAB.
 */
export async function listSheetTabs(): Promise<string[]> {
  if (!env.SHEET_ID) return [];
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: env.SHEET_ID,
    fields: "sheets.properties.title",
  });
  return (meta.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => typeof t === "string");
}

/**
 * Average the values of a given metric across files. Returns NaN if no
 * matching scores exist (callers should treat as "not scored").
 */
export function averageMetric(
  scores: ReadonlyArray<{ metric: string; value: number }>,
  metric: string,
): number {
  const values = scores
    .filter((s) => s.metric === metric)
    .map((s) => s.value);
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
