"use client";

import { Download } from "lucide-react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { formatDurationVerbose } from "@/lib/duration";

/**
 * One row in the export table. Server-rendered, then passed to this
 * component as a prop so the PDF generator on the client has the exact
 * numbers the user is already looking at.
 */
export type ExportRow = {
  name: string;
  email: string;
  category: string;
  submissions: number;
  totalSec: number;
  measuredSubmissions: number;
  /** Comma-separated distinct PICs for this (submitter, category) group.
   *  Null when no submission in the group has a PIC recorded yet. */
  personInCharge: string | null;
  /** Comma-separated distinct "Phone Provided" values for this group.
   *  Already passes through the same fallback chain the dashboard
   *  uses: phoneProvided → driveFolderName (with _DATE suffix stripped)
   *  → category → latest file name. Null when every link is empty. */
  phoneProvided: string | null;
  /** Comma-separated distinct top-level Drive folders ("Hotel 77",
   *  "VNM") this group's submissions live under. Null when none of
   *  the submissions resolve a main. */
  main: string | null;
  /** "5/8/2026 → 5/14/2026" or just "5/8/2026" if all submissions in the
   *  group fall on the same day. */
  dateRange: string;
  /** Sum of duration (deduped by driveFileId) restricted to APPROVED
   *  submissions in this (submitter, category) group. 0 if none. */
  approvedSec: number;
  /** Sum of duration restricted to REJECTED submissions in this group. */
  rejectedSec: number;
  /** Joined distinct reject reasons for the REJECTED submissions in this
   *  group, separated by " | ". Null when nothing in the group was
   *  rejected (or no reasons were recorded). */
  rejectReason: string | null;
};

type Props = {
  rows: ExportRow[];
  filterSummary: string;
  grandTotalSubmissions: number;
  grandTotalSec: number;
  grandApprovedSec: number;
  grandRejectedSec: number;
  /** Whether to include the "Duration approved" column. Hidden when the
   *  operator has filtered to REJECTED-only (cell would always be "-").
   *  Visible otherwise. */
  showApprovedColumn: boolean;
  /** Whether to include the "Duration rejected" + "Reject reason" columns.
   *  Hidden when the operator has filtered to APPROVED-only (they'd be
   *  walls of "-"). Visible otherwise. */
  showRejectedColumns: boolean;
  /** Defaults disable the button so empty exports can't generate a 0-row PDF. */
  disabled?: boolean;
};

/**
 * Generate and download a PDF directly — no browser print dialog. Uses
 * jsPDF + jspdf-autotable so the layout/typography stays consistent with the
 * on-page table and works in every modern browser without OS-level print
 * permissions.
 */
export function PrintButton({
  rows,
  filterSummary,
  grandTotalSubmissions,
  grandTotalSec,
  grandApprovedSec,
  grandRejectedSec,
  showApprovedColumn,
  showRejectedColumns,
  disabled = false,
}: Props) {
  function handleDownload() {
    // Landscape because the table is now 9 columns wide. Portrait would
    // cram the Submitter / Phone / Category / PIC columns into ~30pt each
    // and clip long emails or category names.
    const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });

    // Title
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("Submitter video totals", 40, 50);

    // Filter caption — matches the on-page caption verbatim so the PDF
    // documents exactly which filters were applied at the time of export.
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139); // slate-500
    const captionLine = `Filters: ${filterSummary} · ${rows.length} ${
      rows.length === 1 ? "row" : "rows"
    } · ${grandTotalSubmissions} ${
      grandTotalSubmissions === 1 ? "submission" : "submissions"
    } · total ${formatDurationVerbose(grandTotalSec)}`;
    doc.text(captionLine, 40, 70);

    // Generated-at footer line. UTC so the filename and the export caption
    // can't disagree across timezones.
    const stamp = new Date().toISOString();

    // Helper that renders 0-seconds and missing-data as "-" so the PDF
    // doesn't look like every row sat through a "0s" cell.
    const fmtDurOrDash = (sec: number): string =>
      sec > 0 ? formatDurationVerbose(sec) : "-";

    // Build the table column-set imperatively so the two reject-related
    // columns can be omitted when `showRejectedColumns` is false. Doing it
    // this way keeps the head / body / foot / columnStyles indices in
    // lock-step automatically — no manual re-numbering when the shape
    // changes.
    type Col = {
      head: string;
      cell: (r: ExportRow) => string;
      foot: string;
      style?: {
        halign?: "left" | "right" | "center";
        cellWidth?: number;
        fontStyle?: "normal" | "bold";
      };
    };
    const cols: Col[] = [
      {
        head: "Submitter",
        cell: (r) => `${r.name}\n${r.email}`,
        foot: "Total",
      },
      // Top-level Drive folder ("Hotel 77", "VNM"). Mirrors the
      // MAIN column on /admin so the PDF and the dashboard agree
      // on which project each submitter's videos belong to.
      {
        head: "Main",
        cell: (r) => r.main ?? "-",
        foot: "",
        style: { cellWidth: 60 },
      },
      { head: "Phone Provided", cell: (r) => r.phoneProvided ?? "-", foot: "" },
      { head: "Category", cell: (r) => r.category, foot: "" },
      { head: "PIC", cell: (r) => r.personInCharge ?? "-", foot: "" },
      {
        head: "Submissions",
        cell: (r) =>
          r.measuredSubmissions !== r.submissions
            ? `${r.submissions} (${r.measuredSubmissions} measured)`
            : String(r.submissions),
        foot: String(grandTotalSubmissions),
        style: { halign: "right", cellWidth: 60 },
      },
      {
        head: "Date range",
        cell: (r) => r.dateRange,
        foot: "",
        style: { halign: "center", cellWidth: 90 },
      },
      ...(showApprovedColumn
        ? [
            {
              head: "Duration approved",
              cell: (r: ExportRow) => fmtDurOrDash(r.approvedSec),
              foot: fmtDurOrDash(grandApprovedSec),
              style: { halign: "right", cellWidth: 70 },
            } satisfies Col,
          ]
        : []),
      ...(showRejectedColumns
        ? [
            {
              head: "Duration rejected",
              cell: (r: ExportRow) => fmtDurOrDash(r.rejectedSec),
              foot: fmtDurOrDash(grandRejectedSec),
              style: { halign: "right", cellWidth: 70 },
            } satisfies Col,
          ]
        : []),
      {
        head: "Total duration",
        cell: (r) => formatDurationVerbose(r.totalSec),
        foot: formatDurationVerbose(grandTotalSec),
        style: { halign: "right", cellWidth: 75, fontStyle: "bold" },
      },
      ...(showRejectedColumns
        ? [
            {
              head: "Reject reason",
              cell: (r: ExportRow) => r.rejectReason ?? "-",
              foot: "",
              // Reject reason can be long — let autoTable wrap it. Slightly
              // wider than the duration cells, left-aligned so the text
              // reads naturally.
              style: { halign: "left", cellWidth: 140 },
            } satisfies Col,
          ]
        : []),
    ];

    const columnStyles: Record<number, NonNullable<Col["style"]>> = {};
    cols.forEach((c, i) => {
      if (c.style) columnStyles[i] = c.style;
    });

    autoTable(doc, {
      startY: 90,
      head: [cols.map((c) => c.head)],
      body: rows.map((r) => cols.map((c) => c.cell(r))),
      foot: [cols.map((c) => c.foot)],
      styles: { fontSize: 9, cellPadding: 6 },
      headStyles: {
        fillColor: [241, 245, 249], // slate-100
        textColor: [71, 85, 105], // slate-600
        fontStyle: "bold",
      },
      footStyles: {
        fillColor: [241, 245, 249],
        textColor: [15, 23, 42], // slate-900
        fontStyle: "bold",
      },
      columnStyles,
      margin: { left: 40, right: 40 },
      didDrawPage: (data) => {
        // Page footer with timestamp + page number — useful when the PDF
        // gets emailed around.
        const pageHeight = doc.internal.pageSize.getHeight();
        const pageWidth = doc.internal.pageSize.getWidth();
        doc.setFontSize(8);
        doc.setTextColor(148, 163, 184); // slate-400
        doc.text(`Generated ${stamp}`, 40, pageHeight - 20);
        doc.text(
          `Page ${data.pageNumber}`,
          pageWidth - 40,
          pageHeight - 20,
          { align: "right" },
        );
      },
    });

    // Build a stable, descriptive filename. Slugify the summary so file
    // managers don't choke on punctuation.
    const slug = filterSummary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "all";
    const fileDate = new Date().toISOString().slice(0, 10);
    doc.save(`submitter-totals_${fileDate}_${slug}.pdf`);
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={handleDownload}
      className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 disabled:hover:bg-brand-600"
    >
      <Download className="h-4 w-4" />
      Download PDF
    </button>
  );
}
