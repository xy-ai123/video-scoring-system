"use client";

import { Download } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDurationVerbose } from "@/lib/duration";

/**
 * One normalised row per Submission (NOT the aggregated rows the PDF
 * uses). The CSV uses this shape so each line is exactly one
 * submission — easier to pivot/group in Excel. The on-screen table +
 * PDF continue to use the aggregated `ExportRow`.
 */
export type PerSubmissionRow = {
  name: string;
  email: string;
  category: string;
  personInCharge: string | null;
  main: string | null;
  phoneProvided: string | null;
  /** Pre-formatted M/D/YYYY (server-rendered to avoid timezone drift). */
  date: string;
  status: string;
  /** Submission's deduped file duration in seconds. */
  totalSec: number;
  /** = totalSec when status === "APPROVED" else 0. */
  approvedSec: number;
  /** = totalSec when status === "REJECTED" else 0. */
  rejectedSec: number;
  rejectReason: string | null;
  /** Every VideoFile.fileName attached to this submission, newest
   *  first. Joined with " | " when rendered in the CSV's File Name
   *  cell. Single-file submissions (the common case) show just the
   *  one name. */
  fileNames: string[];
};

/**
 * CSV export companion to PrintButton. Same rows the PDF gets, but:
 *   - opens cleanly in Excel / Google Sheets (no .xlsx dep needed)
 *   - lets the operator toggle which columns to include via an inline
 *     checkbox strip
 *   - column choices persist to localStorage so a frequent operator
 *     only configures once
 *
 * The 6 "core" columns are always emitted (Submitter / Main / Phone /
 * Date / Total videos / Total duration) — the toggles only control
 * the optional analytical columns the PDF also has.
 */

type ColumnKey =
  | "submitter"
  | "email"
  | "main"
  | "phoneProvided"
  | "fileName"
  | "category"
  | "pic"
  | "status"
  | "date"
  | "durationApproved"
  | "durationRejected"
  | "totalVideos"
  | "totalDuration"
  | "rejectReason";

/** Columns the user can't turn off — the report would be useless
 *  without them. The checkbox renders ticked + disabled. */
const REQUIRED_COLUMNS: ReadonlySet<ColumnKey> = new Set([
  "submitter",
  "main",
  "phoneProvided",
  "date",
  "totalVideos",
  "totalDuration",
]);

const COLUMN_META: Record<
  ColumnKey,
  { label: string; cell: (r: PerSubmissionRow) => string }
> = {
  submitter: { label: "Submitter", cell: (r) => r.name },
  email: { label: "Email", cell: (r) => r.email },
  main: { label: "Main", cell: (r) => r.main ?? "" },
  phoneProvided: { label: "Phone Provided", cell: (r) => r.phoneProvided ?? "" },
  fileName: {
    label: "File Name",
    // Join multi-file submissions with " | " so a single CSV cell can
    // hold every file's name. Pipe rather than comma so the CSV
    // escape doesn't have to wrap the whole cell in quotes for the
    // common case of one file. Excel's Text-to-Columns can split on
    // pipe later if the operator needs them in separate cells.
    cell: (r) => r.fileNames.join(" | "),
  },
  category: { label: "Category", cell: (r) => r.category },
  pic: { label: "PIC", cell: (r) => r.personInCharge ?? "" },
  status: { label: "Status", cell: (r) => r.status },
  date: { label: "Date", cell: (r) => r.date },
  durationApproved: {
    label: "Duration approved",
    cell: (r) => (r.approvedSec > 0 ? formatDurationVerbose(r.approvedSec) : ""),
  },
  durationRejected: {
    label: "Duration rejected",
    cell: (r) => (r.rejectedSec > 0 ? formatDurationVerbose(r.rejectedSec) : ""),
  },
  // Per-row value is always "1" because each PerSubmissionRow IS one
  // submission (= one video, in the CSV's "1 submission = 1 video"
  // semantics agreed with the operator). The Total footer row then
  // shows `rows.length`, which Excel can also verify via SUM() over
  // this column. Keeping per-row = "1" instead of "" makes the column
  // semantically truthful AND lets the bottom number be re-derived
  // by anyone double-checking the report.
  totalVideos: {
    label: "Total videos",
    cell: () => "1",
  },
  totalDuration: {
    label: "Total duration",
    cell: (r) => formatDurationVerbose(r.totalSec),
  },
  rejectReason: {
    label: "Reject reason",
    cell: (r) => r.rejectReason ?? "",
  },
};

/** Order columns appear in the file. Toggle order = checkbox order = CSV order. */
const COLUMN_ORDER: readonly ColumnKey[] = [
  "submitter",
  "email",
  "main",
  "phoneProvided",
  "fileName",
  "category",
  "pic",
  "status",
  "date",
  "durationApproved",
  "durationRejected",
  // Total videos sits IMMEDIATELY before Total duration so the two
  // summary metrics read as a pair: "how many" then "how long". The
  // Total footer row's count + duration cells end up side-by-side,
  // matching what the operator asked for ("count beside the duration").
  "totalVideos",
  "totalDuration",
  "rejectReason",
];

const DEFAULT_SELECTED: ReadonlySet<ColumnKey> = new Set<ColumnKey>([
  "submitter",
  "main",
  "phoneProvided",
  "fileName",
  "date",
  "totalVideos",
  "totalDuration",
]);

// v4 schema: added required `totalVideos` column (sits right before
// Total duration). Bumped from v3 so operators with a saved v3
// selection get the new column auto-included on first visit instead
// of relying on the runtime force-include-required guard. Old v3
// entries are ignored (lossless: the defaults are sane and required
// columns are re-added regardless).
const STORAGE_KEY = "vss:export:csvColumns:v4";

/** RFC 4180-style escape: wrap in quotes if value contains ", \n, or ,.
 *  Inside quotes, double up any existing quote. */
function csvEscape(value: string): string {
  if (value === "") return "";
  const needsQuotes = /[",\n\r]/.test(value);
  if (!needsQuotes) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

type Props = {
  /** Per-submission rows. ONE entry per submission — the CSV writes
   *  one line per entry. Built server-side in page.tsx with the same
   *  filter rules as the aggregated PDF rows. */
  rows: PerSubmissionRow[];
  filterSummary: string;
  /** Defaults disable the button so empty exports can't generate an empty CSV. */
  disabled?: boolean;
};

export function CsvButton({ rows, filterSummary, disabled = false }: Props) {
  // Selected columns. Seeded from DEFAULT_SELECTED until localStorage
  // hydrates after mount (same pattern as SubmissionsTable's expandedMains).
  const [selected, setSelected] = useState<Set<ColumnKey>>(
    () => new Set(DEFAULT_SELECTED),
  );
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid: ColumnKey[] = parsed.filter((v): v is ColumnKey =>
            typeof v === "string" && v in COLUMN_META,
          );
          // Force-include required columns so a tampered/old store
          // can't strip the core fields away.
          const next = new Set<ColumnKey>(valid);
          for (const r of REQUIRED_COLUMNS) next.add(r);
          setSelected(next);
        }
      }
    } catch {
      // bad JSON / private mode / quota — fall back to default
    }
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(Array.from(selected)),
      );
    } catch {
      // Best-effort persistence. Quota / private mode = silent no-op.
    }
  }, [selected]);

  const toggle = useCallback((key: ColumnKey) => {
    if (REQUIRED_COLUMNS.has(key)) return; // can't turn off required
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleDownload = useCallback(() => {
    if (rows.length === 0) return;
    const cols = COLUMN_ORDER.filter((k) => selected.has(k));
    const header = cols.map((k) => COLUMN_META[k].label).join(",");
    const body = rows
      .map((r) =>
        cols.map((k) => csvEscape(COLUMN_META[k].cell(r))).join(","),
      )
      .join("\n");
    // Summary footer: one row at the very bottom of the CSV.
    //   - Submitter column   → literal "Total"
    //   - Total videos col   → rows.length (count of submissions in the
    //                          export, equal to SUM() over the per-row
    //                          "1"s above — Excel can re-verify it)
    //   - Total duration col → formatted sum of every per-row totalSec
    //   - every other cell   → blank
    // submitter, totalVideos, and totalDuration are all REQUIRED so
    // the row is well-defined regardless of which optional columns
    // the operator toggled on.
    const grandTotalSec = rows.reduce((acc, r) => acc + r.totalSec, 0);
    const totalRow = cols
      .map((k) => {
        if (k === "submitter") return csvEscape("Total");
        if (k === "totalVideos") return csvEscape(String(rows.length));
        if (k === "totalDuration")
          return csvEscape(formatDurationVerbose(grandTotalSec));
        return ""; // blank cell — escape() of "" is also "" so it's a no-op
      })
      .join(",");
    // Add a UTF-8 BOM so Excel on Windows auto-detects the encoding —
    // without it, non-ASCII names (e.g. accented characters) can
    // render as mojibake when the file is opened by double-click.
    const csv = `﻿${header}\n${body}\n${totalRow}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Filename: timestamped so successive downloads don't overwrite
    // each other in the Downloads folder.
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace(/T/, "_")
      .slice(0, 19);
    a.download = `submitter-video-totals-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a short delay so the browser has time to read the URL.
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }, [rows, selected]);

  // The "filterSummary" is rendered as a small hint above the
  // checkbox strip so the operator knows what subset they're about
  // to export. Tiny, always-fresh signal.
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span className="font-medium uppercase tracking-wide text-slate-500">
          CSV columns
        </span>
        {COLUMN_ORDER.map((key) => {
          const required = REQUIRED_COLUMNS.has(key);
          const checked = selected.has(key);
          return (
            <label
              key={key}
              className={
                "inline-flex items-center gap-1 " +
                (required ? "cursor-not-allowed text-slate-400" : "cursor-pointer")
              }
              title={
                required
                  ? "Always included in the CSV"
                  : "Click to include / exclude this column"
              }
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={required}
                onChange={() => toggle(key)}
                className="h-3 w-3 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-100"
              />
              <span className={required ? "italic" : ""}>
                {COLUMN_META[key].label}
              </span>
            </label>
          );
        })}
      </div>
      <button
        type="button"
        onClick={handleDownload}
        disabled={disabled || rows.length === 0}
        title={`Download a CSV with ${selected.size} column${selected.size === 1 ? "" : "s"}. Current filters: ${filterSummary}`}
        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
      >
        <Download className="h-4 w-4" />
        Download CSV
      </button>
    </div>
  );
}
