import Link from "next/link";
import { prisma, type SubmissionStatus } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { formatDurationVerbose } from "@/lib/duration";
import { getDriveMains } from "@/lib/driveMains";
import { PrintButton, type ExportRow } from "./PrintButton";
import { CsvButton, type PerSubmissionRow } from "./CsvButton";

/**
 * Strip a clip-output date suffix from a Drive-folder-style label.
 * "VPM0167_23MAY"     → "VPM0167"
 * "VPM0167_24_25MAY"  → "VPM0167"
 * "VPM0167"           → "VPM0167" (no change)
 * Anything without an underscore is returned unchanged.
 *
 * Same rule as the dashboard's PhoneProvidedCell uses, so the export
 * page reads exactly the same as the table on /admin.
 */
function shortenDriveFolderLabel(s: string): string {
  const idx = s.indexOf("_");
  return idx > 0 ? s.slice(0, idx) : s;
}

/**
 * Extract a "(SUB)" prefix candidate from a folder name or a filename
 * for filename-prefix main resolution. Mirrors the helper used in
 * /admin/page.tsx so an "(Other)"-bound row on the dashboard maps to
 * the same main here.
 */
function extractPrefix(s: string | null | undefined): string | null {
  if (!s) return null;
  const noExt = s.replace(/[\\/]/g, "_").replace(/\.[^.]+$/, "");
  const m = noExt.match(/^([A-Za-z0-9]+)(?:[-_]|$)/);
  return m && m[1] ? m[1] : null;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Aggregate per-submitter total duration for printing as a PDF.
 *
 * Filters (all optional, combined with AND):
 *   ?from=YYYY-MM-DD       inclusive lower bound on Submission.createdAt
 *   ?to=YYYY-MM-DD         inclusive upper bound (we add a day to make it
 *                          end-of-day in the user's local TZ, matching the
 *                          date-range filter on the main dashboard)
 *   ?submitter=string      case-insensitive substring match against either
 *                          submitter email or display name
 *   ?category=string       case-insensitive substring match against the
 *                          submission category column (form-submitted ones
 *                          like "Arts" / "Gardening Tasks" or drive-folder
 *                          names like "Testing folder")
 *   ?phoneProvided=string  case-insensitive substring match against the
 *                          submission's "Phone Provided" value (e.g.
 *                          "VPM0157", or just "VPM" to catch all)
 *   ?pic=string            case-insensitive substring match against the
 *                          submission's "Person in Charge" name. Matches
 *                          only rows where a PIC has been recorded — rows
 *                          with no PIC are excluded by definition.
 *   ?approvedOnly=true     only count submissions whose status is APPROVED;
 *                          unset/blank = count every status
 *   ?rejectedOnly=true     only count submissions whose status is REJECTED.
 *                          Combining with approvedOnly=true OR-merges the
 *                          two: you'll see every APPROVED *or* REJECTED
 *                          submission (everything that's been decided).
 *
 * Per submission, durations are deduped by driveFileId (same rule used by
 * the dashboard's per-row total). Per submitter, we sum those per-submission
 * durations across however many submissions they have in range.
 */

type SearchParams = {
  from?: string;
  to?: string;
  submitter?: string;
  category?: string;
  phoneProvided?: string;
  pic?: string;
  approvedOnly?: string;
  rejectedOnly?: string;
  /**
   * Top-level Drive folder filter ("Hotel 77", "VNM", …). Computed
   * from the submission's source-video folder ancestry the same way
   * /admin's Main column does; matches via case-insensitive substring
   * so "hot" finds Hotel 77.
   */
  main?: string;
  /**
   * 3-state Clipped filter. Values:
   *   "CLIPPED"   — only submissions whose file name contains "(clipped)"
   *   "UNCLIPPED" — only submissions where NO file name contains "(clipped)"
   *   anything else (incl. unset) — no constraint
   * Same rule the dashboard's Clipped/Unclipped chips use, so the
   * counts agree across pages.
   */
  clipped?: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function parseLocalDay(s: string | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dedupedSubmissionDuration(
  files: { driveFileId: string; durationSec: number | null }[],
): number {
  const seen = new Map<string, number | null>();
  for (const f of files) {
    if (!seen.has(f.driveFileId)) seen.set(f.driveFileId, f.durationSec);
    else if (seen.get(f.driveFileId) == null && f.durationSec != null) {
      seen.set(f.driveFileId, f.durationSec);
    }
  }
  let total = 0;
  for (const v of seen.values()) if (v != null) total += v;
  return total;
}

export default async function ExportPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }

  const fromDate = parseLocalDay(searchParams.from);
  const toDate = parseLocalDay(searchParams.to);
  const submitterQuery = (searchParams.submitter ?? "").trim();
  const categoryQuery = (searchParams.category ?? "").trim();
  const phoneQuery = (searchParams.phoneProvided ?? "").trim();
  const picQuery = (searchParams.pic ?? "").trim();
  const mainQuery = (searchParams.main ?? "").trim();
  // Normalize the clipped filter to a 3-state value so the rest of the
  // code can compare against constants. Anything we don't recognise
  // (including "" and "ALL") becomes "ALL" = no constraint.
  const clippedFilterRaw = (searchParams.clipped ?? "").trim().toUpperCase();
  const clippedFilter: "ALL" | "CLIPPED" | "UNCLIPPED" =
    clippedFilterRaw === "CLIPPED"
      ? "CLIPPED"
      : clippedFilterRaw === "UNCLIPPED"
        ? "UNCLIPPED"
        : "ALL";
  const approvedOnly = searchParams.approvedOnly === "true";
  const rejectedOnly = searchParams.rejectedOnly === "true";

  // Drive-folder → main mapping. Same cached helper the dashboard
  // uses; on cache miss this runs `dumpDriveMains.ts` which takes a
  // few seconds. Result is shared by every chart/table that needs to
  // know which project a folder belongs to.
  const mains = await getDriveMains();
  const knownMains = mains.knownMains; // for the chip strip below

  // Status filter, computed via the `in` operator so we can OR the two
  // toggles cleanly: approved-only → ["APPROVED"], rejected-only →
  // ["REJECTED"], both ticked → ["APPROVED","REJECTED"] (every "decided"
  // submission), neither → no constraint.
  const statusFilter = (() => {
    const allowed: SubmissionStatus[] = [];
    if (approvedOnly) allowed.push("APPROVED");
    if (rejectedOnly) allowed.push("REJECTED");
    if (allowed.length === 0) return null; // no constraint
    return { in: allowed };
  })();

  // Build the where clause. Empty filters mean "all submissions" (non-deleted).
  const createdAt: { gte?: Date; lt?: Date } = {};
  if (fromDate) createdAt.gte = fromDate;
  if (toDate) createdAt.lt = new Date(toDate.getTime() + ONE_DAY_MS);

  // Where clause shared by the main listing and the rate card below.
  // Everything *except* the status toggle goes in here — that way the rate
  // card can ignore the approved/rejected toggles and always report the
  // overall split for whatever (submitter / phone / PIC / …) slice the
  // operator is looking at. Toggling "Only count APPROVED" shouldn't make
  // the approval rate jump to 100%.
  const baseWhere = {
    deletedAt: null,
    ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
    ...(submitterQuery.length > 0
      ? {
          OR: [
            {
              submitterEmail: {
                contains: submitterQuery,
                mode: "insensitive" as const,
              },
            },
            {
              submitterName: {
                contains: submitterQuery,
                mode: "insensitive" as const,
              },
            },
          ],
        }
      : {}),
    ...(categoryQuery.length > 0
      ? {
          category: {
            contains: categoryQuery,
            mode: "insensitive" as const,
          },
        }
      : {}),
    ...(phoneQuery.length > 0
      ? {
          phoneProvided: {
            contains: phoneQuery,
            mode: "insensitive" as const,
          },
        }
      : {}),
    ...(picQuery.length > 0
      ? {
          personInCharge: {
            contains: picQuery,
            mode: "insensitive" as const,
          },
        }
      : {}),
    // Clipped filter — pushed down to the SQL level so the row count
    // we aggregate matches the chip selection exactly (no later
    // post-filter pass needed). "(clipped)" is a literal substring;
    // detect_hands.py writes it on every output filename, so this is
    // the same signal /admin's Clipped chip uses.
    ...(clippedFilter === "CLIPPED"
      ? {
          files: {
            some: {
              fileName: { contains: "(clipped)", mode: "insensitive" as const },
            },
          },
        }
      : {}),
    ...(clippedFilter === "UNCLIPPED"
      ? {
          // `none` is Prisma's negative-existence quantifier — true
          // for submissions whose every file name has NO "(clipped)".
          files: {
            none: {
              fileName: { contains: "(clipped)", mode: "insensitive" as const },
            },
          },
        }
      : {}),
  };

  const submissions = await prisma.submission.findMany({
    where: {
      ...baseWhere,
      ...(statusFilter ? { status: statusFilter } : {}),
    },
    select: {
      id: true,
      submitterEmail: true,
      submitterName: true,
      category: true,
      personInCharge: true,
      phoneProvided: true,
      // Needed for main resolution + Phone-Provided fallback chain so
      // the export's Phone Provided cell shows what the dashboard
      // shows (driveFolderName when phoneProvided is null) and Main
      // can be derived from the folder/filename prefix.
      driveFolderName: true,
      status: true,
      rejectReason: true,
      createdAt: true,
      files: {
        select: {
          driveFileId: true,
          durationSec: true,
          fileName: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Approval / rejection rate stats. Uses the same filters as the listing
  // but *deliberately* ignores the approvedOnly / rejectedOnly toggles so
  // the rates always describe the underlying population (e.g. for phone
  // VPM0157 with 12 submissions: 8 approved, 3 rejected, 1 pending →
  // 66.7% approved / 25% rejected, regardless of whether the operator is
  // currently looking at only the approved rows).
  const statsByStatus = await prisma.submission.groupBy({
    by: ["status"],
    where: baseWhere,
    _count: { _all: true },
  });
  const statsCount = (s: SubmissionStatus): number =>
    statsByStatus.find((g) => g.status === s)?._count._all ?? 0;
  const rateApprovedCount = statsCount("APPROVED");
  const rateRejectedCount = statsCount("REJECTED");
  const rateTotalCount = statsByStatus.reduce(
    (acc, g) => acc + g._count._all,
    0,
  );
  const rateApprovedPct =
    rateTotalCount > 0 ? (rateApprovedCount / rateTotalCount) * 100 : 0;
  const rateRejectedPct =
    rateTotalCount > 0 ? (rateRejectedCount / rateTotalCount) * 100 : 0;
  const ratePendingCount =
    rateTotalCount - rateApprovedCount - rateRejectedCount;

  /**
   * Resolve a submission's top-level Drive main folder. Matches the
   * /admin/page.tsx logic exactly so the export's Main column shows
   * the same value the dashboard does for the same row. Tries:
   *   1. exact match on driveFolderName
   *   2. prefix-of-driveFolderName before first '-' or '_'
   *   3. prefix-of-latest-filename
   */
  function resolveMain(
    driveFolderName: string | null,
    fileName: string | null,
  ): string | null {
    if (driveFolderName) {
      const exact = mains.subFolderNameToMain[driveFolderName];
      if (exact) return exact;
      const fp = extractPrefix(driveFolderName);
      if (fp) {
        const via = mains.subFolderNameToMain[fp];
        if (via) return via;
      }
    }
    const fp = extractPrefix(fileName);
    if (fp) {
      const via = mains.subFolderNameToMain[fp];
      if (via) return via;
    }
    return null;
  }

  /**
   * Same fallback chain the dashboard's PhoneProvidedCell uses:
   *   phoneProvided  →  driveFolderName  →  category  →  latest file name
   * with the clip-output date suffix stripped on driveFolderName-style
   * values. Returns null when every link in the chain is empty.
   */
  function phoneDisplayValue(s: {
    phoneProvided: string | null;
    driveFolderName: string | null;
    category: string | null;
    files: { fileName: string }[];
  }): string | null {
    const phone = s.phoneProvided?.trim();
    if (phone) return phone;
    const folder = s.driveFolderName?.trim();
    if (folder) return shortenDriveFolderLabel(folder);
    const cat = s.category?.trim();
    if (cat) return cat;
    const fname = s.files[0]?.fileName?.trim();
    if (fname) return fname;
    return null;
  }

  // Mask rule: when a submission's computed Phone Provided value
  // equals a known top-level Drive folder ("Hotel 77", "VNM"), it's
  // not a real phone identifier — the submission's source file
  // lives directly inside the main folder rather than under a VPM
  // sub. We DON'T drop those rows — the operator still wants to see
  // them in the export and have their durations counted. We just
  // null out the phoneDisplay so they bucket under "(none)" and
  // render "-" in the Phone Provided column. The Main column still
  // resolves correctly (Hotel 77) via resolveMain() because that
  // walks the folder graph independently. Case-insensitive lookup.
  const phoneNamesToMask = new Set(
    mains.knownMains.map((m) => m.toLowerCase()),
  );

  // Group by (submitter email, category, phone-display-value).
  //
  // Earlier the key was (email, category) and Phone Provided was a
  // comma-joined Set of every distinct value the submitter touched.
  // That made it impossible to break out per-phone totals — every
  // dataops row collapsed into one. Splitting on phone gives one row
  // per (submitter, category, phone), so the per-phone numbers add
  // up correctly across rows and the PDF reads like a real billing
  // statement: "dataops × VPM0166 = N submissions, M minutes".
  //
  // Per-submission fields still merged with helpers:
  //   - PIC: distinct names → joined "Wei Ling, John Lim" (or "-")
  //   - mains: distinct top-level Drive folders for THIS phone's
  //     submissions → joined "Hotel 77" (typically 1)
  //   - dateRange: earliest + latest createdAt within the bucket
  type Agg = ExportRow & {
    latestAt: Date;
    pics: Set<string>;
    mainsSet: Set<string>;
    rejectReasons: Set<string>;
    firstAt: Date;
    lastAt: Date;
  };
  const byKey = new Map<string, Agg>();
  for (const s of submissions) {
    const rawPhoneDisplay = phoneDisplayValue(s);
    // Mask main-folder names → null so the row buckets under "(none)"
    // and renders "-" in Phone Provided. The submission still counts.
    const phoneDisplay =
      rawPhoneDisplay &&
      phoneNamesToMask.has(rawPhoneDisplay.toLowerCase())
        ? null
        : rawPhoneDisplay;
    // Key encodes the bucket exactly. Null phone → "(none)" so empty
    // phone-provided submissions all bucket together per (email,
    // category) — typically becomes the "direct-to-main" row.
    const phoneKey = phoneDisplay ?? "(none)";
    const key = `${s.submitterEmail.toLowerCase()}::${s.category}::${phoneKey}`;
    const dur = dedupedSubmissionDuration(s.files);
    const measured = s.files.some((f) => f.durationSec != null);
    // Split duration into approved / rejected buckets so the PDF can show
    // them side-by-side. "Other" statuses (PENDING / SCORING / SCORED /
    // FAILED) only contribute to totalSec, not to either of these two.
    const approvedDur = s.status === "APPROVED" ? dur : 0;
    const rejectedDur = s.status === "REJECTED" ? dur : 0;
    const mainName = resolveMain(s.driveFolderName, s.files[0]?.fileName ?? null);
    const existing = byKey.get(key);
    if (!existing) {
      const pics = new Set<string>();
      if (s.personInCharge) pics.add(s.personInCharge);
      const mainsSet = new Set<string>();
      if (mainName) mainsSet.add(mainName);
      const rejectReasons = new Set<string>();
      if (s.rejectReason) rejectReasons.add(s.rejectReason);
      byKey.set(key, {
        email: s.submitterEmail,
        name: s.submitterName,
        category: s.category,
        latestAt: s.createdAt,
        submissions: 1,
        totalSec: dur,
        approvedSec: approvedDur,
        rejectedSec: rejectedDur,
        measuredSubmissions: measured ? 1 : 0,
        pics,
        mainsSet,
        rejectReasons,
        firstAt: s.createdAt,
        lastAt: s.createdAt,
        personInCharge: s.personInCharge ?? null,
        // phoneProvided is now the single value that defines this
        // bucket — no Set, no comma-join. May be null when the
        // submission had no phone identifier anywhere in its chain.
        phoneProvided: phoneDisplay,
        main: mainName,
        rejectReason: s.rejectReason ?? null,
        dateRange: "",
      });
    } else {
      existing.submissions += 1;
      existing.totalSec += dur;
      existing.approvedSec += approvedDur;
      existing.rejectedSec += rejectedDur;
      if (measured) existing.measuredSubmissions += 1;
      if (s.personInCharge) existing.pics.add(s.personInCharge);
      if (mainName) existing.mainsSet.add(mainName);
      if (s.rejectReason) existing.rejectReasons.add(s.rejectReason);
      if (s.createdAt < existing.firstAt) existing.firstAt = s.createdAt;
      if (s.createdAt > existing.lastAt) existing.lastAt = s.createdAt;
      if (s.createdAt > existing.latestAt) {
        existing.latestAt = s.createdAt;
        existing.name = s.submitterName;
      }
    }
  }
  function formatDateRange(first: Date, last: Date): string {
    const f = first.toLocaleDateString("en-US");
    const l = last.toLocaleDateString("en-US");
    return f === l ? f : `${f} → ${l}`;
  }
  let rows: ExportRow[] = Array.from(byKey.values())
    .sort((a, b) => b.totalSec - a.totalSec)
    .map(({
      latestAt: _u1,
      pics,
      mainsSet,
      rejectReasons,
      firstAt,
      lastAt,
      ...rest
    }) => ({
      ...rest,
      // Render distinct values as a comma-separated string; empty set →
      // null so the renderer can show "-" instead. Multiple reject reasons
      // (one per rejected submission in the group) join with " | " so
      // commas inside a reason don't get confused with the separator.
      personInCharge: pics.size === 0 ? null : Array.from(pics).join(", "),
      // phoneProvided is already a single value pulled from the bucket
      // key (see `rest` above); no Set/join here anymore.
      main: mainsSet.size === 0 ? null : Array.from(mainsSet).sort().join(", "),
      rejectReason:
        rejectReasons.size === 0
          ? null
          : Array.from(rejectReasons).join(" | "),
      dateRange: formatDateRange(firstAt, lastAt),
    }));

  // Post-aggregation Main filter. We do this AFTER the bucketize because
  // `main` is computed from getDriveMains() (a Drive walk) plus
  // filename/folder fallbacks — Prisma can't natively filter on it.
  // Case-insensitive substring match against the joined main list so a
  // row matching ANY of its mains keeps the row visible.
  if (mainQuery.length > 0) {
    const q = mainQuery.toLowerCase();
    rows = rows.filter((r) => (r.main ?? "").toLowerCase().includes(q));
  }

  // ---- Per-submission CSV rows ----------------------------------------
  // CSV download uses a normalised one-row-per-submission view (rather
  // than the aggregated rows the on-screen table + PDF use). This makes
  // a CSV easier to pivot/group in Excel — each line is one event.
  //
  // Applies the same drop / mask / filter rules so the CSV matches the
  // aggregated counts exactly:
  //   - phoneDisplay masked when it equals a known main name (so the
  //     row's Phone Provided ends up blank, matching the aggregated
  //     "(none)" row).
  //   - mainQuery filter applied per-submission against the resolved main.
  //   - The clipped filter is already in baseWhere → Prisma did it.
  const perSubmissionRows: PerSubmissionRow[] = [];
  for (const s of submissions) {
    const rawPhoneDisplay = phoneDisplayValue(s);
    const phoneDisplay =
      rawPhoneDisplay &&
      phoneNamesToMask.has(rawPhoneDisplay.toLowerCase())
        ? null
        : rawPhoneDisplay;
    const mainName = resolveMain(s.driveFolderName, s.files[0]?.fileName ?? null);
    if (mainQuery.length > 0) {
      if (!(mainName ?? "").toLowerCase().includes(mainQuery.toLowerCase())) {
        continue;
      }
    }
    const dur = dedupedSubmissionDuration(s.files);
    // Distinct file names, preserving the DESC-by-createdAt order
    // Prisma returned them in. Multiple identical names can occur
    // when a video gets ingested twice via different folders — dedup
    // so the CSV cell isn't "X.mp4 | X.mp4". One file = one name.
    const fileNames: string[] = [];
    const seen = new Set<string>();
    for (const f of s.files) {
      if (!seen.has(f.fileName)) {
        seen.add(f.fileName);
        fileNames.push(f.fileName);
      }
    }
    perSubmissionRows.push({
      name: s.submitterName,
      email: s.submitterEmail,
      category: s.category,
      personInCharge: s.personInCharge,
      main: mainName,
      phoneProvided: phoneDisplay,
      date: s.createdAt.toLocaleDateString("en-US"),
      status: s.status,
      totalSec: dur,
      approvedSec: s.status === "APPROVED" ? dur : 0,
      rejectedSec: s.status === "REJECTED" ? dur : 0,
      rejectReason: s.rejectReason ?? null,
      fileNames,
    });
  }

  const grandTotalSec = rows.reduce((acc, r) => acc + r.totalSec, 0);
  const grandTotalSubmissions = rows.reduce((acc, r) => acc + r.submissions, 0);
  const grandApprovedSec = rows.reduce((acc, r) => acc + r.approvedSec, 0);
  const grandRejectedSec = rows.reduce((acc, r) => acc + r.rejectedSec, 0);

  // The reject-related columns (Duration rejected + Reject reason) only
  // make sense when the result set might contain rejected rows. If the
  // operator has filtered to APPROVED only, both columns would just be
  // walls of "-" — hide them. They reappear as soon as the rejected-only
  // filter is also (or instead) checked, or when neither filter is on.
  const showRejectedColumns = !approvedOnly || rejectedOnly;
  // Symmetric rule for the Duration approved column: hide when the
  // operator has narrowed to REJECTED-only (the cell would always be "-").
  // Visible when no filter, when approved-only, or when both are checked.
  const showApprovedColumn = !rejectedOnly || approvedOnly;

  const filterParts: string[] = [];
  if (fromDate) filterParts.push(`from ${searchParams.from}`);
  if (toDate) filterParts.push(`to ${searchParams.to}`);
  if (submitterQuery) filterParts.push(`submitter ~ "${submitterQuery}"`);
  if (categoryQuery) filterParts.push(`category ~ "${categoryQuery}"`);
  if (phoneQuery) filterParts.push(`phone ~ "${phoneQuery}"`);
  if (picQuery) filterParts.push(`PIC ~ "${picQuery}"`);
  if (mainQuery) filterParts.push(`main ~ "${mainQuery}"`);
  if (clippedFilter !== "ALL") filterParts.push(clippedFilter.toLowerCase());
  if (approvedOnly) filterParts.push("APPROVED only");
  if (rejectedOnly) filterParts.push("REJECTED only");
  const filterSummary =
    filterParts.length > 0 ? filterParts.join(" · ") : "all submissions";

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin"
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          ← Back to submissions
        </Link>
      </div>

      {/* Filter form. GET-style so the result is encoded in the URL — that
          way "Download PDF" exports whatever you're currently looking at. */}
      <form
        className="rounded-xl border border-slate-200 bg-white p-4"
        method="get"
        action="/admin/export"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label
              htmlFor="vss-export-from"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              From
            </label>
            <input
              id="vss-export-from"
              name="from"
              type="date"
              defaultValue={searchParams.from ?? ""}
              max={searchParams.to || undefined}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div>
            <label
              htmlFor="vss-export-to"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              To
            </label>
            <input
              id="vss-export-to"
              name="to"
              type="date"
              defaultValue={searchParams.to ?? ""}
              min={searchParams.from || undefined}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label
              htmlFor="vss-export-submitter"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Submitter (name or email contains)
            </label>
            <input
              id="vss-export-submitter"
              name="submitter"
              type="search"
              placeholder="leave blank for all submitters"
              defaultValue={searchParams.submitter ?? ""}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label
              htmlFor="vss-export-category"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Category (contains)
            </label>
            <input
              id="vss-export-category"
              name="category"
              type="search"
              placeholder='e.g. "Arts", "Testing folder", "Drive"'
              defaultValue={searchParams.category ?? ""}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label
              htmlFor="vss-export-phone"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Phone Provided (contains)
            </label>
            <input
              id="vss-export-phone"
              name="phoneProvided"
              type="search"
              placeholder='e.g. "VPM1060", or "VPM" for all'
              defaultValue={searchParams.phoneProvided ?? ""}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label
              htmlFor="vss-export-pic"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Person in Charge (contains)
            </label>
            <input
              id="vss-export-pic"
              name="pic"
              type="search"
              placeholder='e.g. "Wei Ling"'
              defaultValue={searchParams.pic ?? ""}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          {/* Main (top-level Drive folder) filter. Matches the
              dashboard's Main chip row. Click a chip to autofill the
              text input below, then submit. Empty = no filter. */}
          <div className="sm:col-span-2">
            <label
              htmlFor="vss-export-main"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Main (top-level Drive folder, contains)
            </label>
            <input
              id="vss-export-main"
              name="main"
              type="search"
              placeholder='e.g. "Hotel 77", "VNM"'
              defaultValue={searchParams.main ?? ""}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            {knownMains.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-slate-500">Quick pick:</span>
                {/* Each chip is a plain <Link> that swaps the `main`
                    query param. Keeps every other filter intact via
                    URLSearchParams pass-through. */}
                {(() => {
                  // Build a base param-string from everything except `main`,
                  // so each chip flips only the main value (preserving the
                  // rest of the filter state).
                  const baseParams = new URLSearchParams();
                  if (searchParams.from) baseParams.set("from", searchParams.from);
                  if (searchParams.to) baseParams.set("to", searchParams.to);
                  if (searchParams.submitter)
                    baseParams.set("submitter", searchParams.submitter);
                  if (searchParams.category)
                    baseParams.set("category", searchParams.category);
                  if (searchParams.phoneProvided)
                    baseParams.set("phoneProvided", searchParams.phoneProvided);
                  if (searchParams.pic) baseParams.set("pic", searchParams.pic);
                  if (approvedOnly) baseParams.set("approvedOnly", "true");
                  if (rejectedOnly) baseParams.set("rejectedOnly", "true");
                  // Preserve the Clipped chip state when flipping
                  // Main — otherwise picking "Hotel 77" would
                  // accidentally drop a Clipped/Unclipped filter.
                  if (clippedFilter !== "ALL")
                    baseParams.set("clipped", clippedFilter);
                  const chipFor = (label: string, value: string) => {
                    const p = new URLSearchParams(baseParams);
                    if (value) p.set("main", value);
                    const active =
                      (mainQuery || "").toLowerCase() === value.toLowerCase();
                    const href = `/admin/export${p.toString() ? `?${p.toString()}` : ""}`;
                    return (
                      <Link
                        key={`main-chip-${label}`}
                        href={href}
                        className={
                          "rounded-full border px-2.5 py-0.5 " +
                          (active
                            ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
                        }
                      >
                        {label}
                      </Link>
                    );
                  };
                  return [
                    chipFor("All mains", ""),
                    ...knownMains.map((m) => chipFor(m, m)),
                  ];
                })()}
              </div>
            ) : null}
          </div>
          {/* Clipped / Unclipped chip strip. Same rule as /admin's
              Clipped chip: a submission counts as Clipped iff ANY of
              its files has "(clipped)" in the file name. The hidden
              <input> carries the selected value when the form is
              submitted, so the URL ends up with ?clipped=CLIPPED (or
              UNCLIPPED / unset). Each chip is a plain <Link> that
              re-builds the URL preserving all other filter state. */}
          <div className="sm:col-span-2">
            <label
              htmlFor="vss-export-clipped-hidden"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Clip status
            </label>
            <input
              id="vss-export-clipped-hidden"
              name="clipped"
              type="hidden"
              value={clippedFilter === "ALL" ? "" : clippedFilter}
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              {(() => {
                const baseParams = new URLSearchParams();
                if (searchParams.from) baseParams.set("from", searchParams.from);
                if (searchParams.to) baseParams.set("to", searchParams.to);
                if (searchParams.submitter)
                  baseParams.set("submitter", searchParams.submitter);
                if (searchParams.category)
                  baseParams.set("category", searchParams.category);
                if (searchParams.phoneProvided)
                  baseParams.set("phoneProvided", searchParams.phoneProvided);
                if (searchParams.pic) baseParams.set("pic", searchParams.pic);
                if (mainQuery) baseParams.set("main", mainQuery);
                if (approvedOnly) baseParams.set("approvedOnly", "true");
                if (rejectedOnly) baseParams.set("rejectedOnly", "true");
                const chipFor = (
                  label: string,
                  value: "" | "CLIPPED" | "UNCLIPPED",
                ) => {
                  const p = new URLSearchParams(baseParams);
                  if (value) p.set("clipped", value);
                  const active =
                    (value === "" && clippedFilter === "ALL") ||
                    value === clippedFilter;
                  const href = `/admin/export${p.toString() ? `?${p.toString()}` : ""}`;
                  return (
                    <Link
                      key={`clipped-chip-${label}`}
                      href={href}
                      className={
                        "rounded-full border px-2.5 py-0.5 " +
                        (active
                          ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
                      }
                    >
                      {label}
                    </Link>
                  );
                };
                return [
                  chipFor("All", ""),
                  chipFor("Clipped", "CLIPPED"),
                  chipFor("Unclipped", "UNCLIPPED"),
                ];
              })()}
            </div>
            <p className="mt-1 text-[11px] text-slate-400">
              Same rule as the dashboard: a submission is Clipped when
              one of its file names contains{" "}
              <code className="rounded bg-slate-100 px-1">(clipped)</code>.
            </p>
          </div>
          <div className="sm:col-span-2 sm:self-end">
            <div className="flex flex-wrap gap-2">
              <label
                htmlFor="vss-export-approved"
                className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                <input
                  id="vss-export-approved"
                  name="approvedOnly"
                  type="checkbox"
                  value="true"
                  defaultChecked={approvedOnly}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                Only count APPROVED submissions
              </label>
              <label
                htmlFor="vss-export-rejected"
                className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                <input
                  id="vss-export-rejected"
                  name="rejectedOnly"
                  type="checkbox"
                  value="true"
                  defaultChecked={rejectedOnly}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                Only count REJECTED submissions
              </label>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Apply filters
          </button>
          <Link
            href="/admin/export"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50"
          >
            Reset
          </Link>
          <span className="flex-1" />
          {/* Two download buttons: PDF (always the same columns) and
              CSV (per-column toggleable, persists choices to
              localStorage). CsvButton has its own checkbox strip above
              its download button — let it flow below the Apply / Reset
              row so the form layout stays clean. */}
          <PrintButton
            rows={rows}
            filterSummary={filterSummary}
            grandTotalSubmissions={grandTotalSubmissions}
            grandTotalSec={grandTotalSec}
            grandApprovedSec={grandApprovedSec}
            grandRejectedSec={grandRejectedSec}
            showApprovedColumn={showApprovedColumn}
            showRejectedColumns={showRejectedColumns}
            disabled={rows.length === 0}
          />
        </div>
        <div className="mt-3 border-t border-slate-100 pt-3">
          <CsvButton
            rows={perSubmissionRows}
            filterSummary={filterSummary}
            disabled={perSubmissionRows.length === 0}
          />
        </div>
      </form>

      {/* Approval / rejection rate card. Sits between the filter form and
          the results table so the operator sees the overall split for the
          currently-applied filters (date / submitter / category / phone /
          PIC) at a glance. Rates ignore the approved-only / rejected-only
          toggles on purpose — those just restrict what's *listed*; the
          rates still describe the full filtered population. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
          <div className="text-xs uppercase tracking-wide text-emerald-700">
            Approved rate
          </div>
          <div className="mt-1 text-2xl font-semibold text-emerald-900 tabular-nums">
            {rateTotalCount > 0 ? `${rateApprovedPct.toFixed(1)}%` : "—"}
          </div>
          <div className="text-xs text-emerald-700/80">
            {rateApprovedCount} of {rateTotalCount}{" "}
            {rateTotalCount === 1 ? "submission" : "submissions"}
          </div>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-4">
          <div className="text-xs uppercase tracking-wide text-rose-700">
            Rejected rate
          </div>
          <div className="mt-1 text-2xl font-semibold text-rose-900 tabular-nums">
            {rateTotalCount > 0 ? `${rateRejectedPct.toFixed(1)}%` : "—"}
          </div>
          <div className="text-xs text-rose-700/80">
            {rateRejectedCount} of {rateTotalCount}{" "}
            {rateTotalCount === 1 ? "submission" : "submissions"}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          <div className="text-xs uppercase tracking-wide text-slate-600">
            Pending decision
          </div>
          <div className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">
            {rateTotalCount > 0 ? ratePendingCount : "—"}
          </div>
          <div className="text-xs text-slate-500">
            not yet approved or rejected
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <header className="mb-4 flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            Submitter video totals
          </h1>
          <p className="text-xs text-slate-500">
            Filters: {filterSummary} · {rows.length}{" "}
            {rows.length === 1 ? "submitter" : "submitters"} ·{" "}
            {grandTotalSubmissions}{" "}
            {grandTotalSubmissions === 1 ? "submission" : "submissions"} ·
            total {formatDurationVerbose(grandTotalSec)}
          </p>
        </header>

        {rows.length === 0 ? (
          <div className="rounded-md bg-slate-50 px-3 py-6 text-center text-sm text-slate-400">
            No submissions match these filters.
          </div>
        ) : (
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Submitter</th>
                <th className="px-3 py-2">Main</th>
                <th className="px-3 py-2">Phone Provided</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">PIC</th>
                <th className="px-3 py-2 text-right">Submissions</th>
                <th className="px-3 py-2 text-center">Date range</th>
                {showApprovedColumn ? (
                  <th className="px-3 py-2 text-right">Duration approved</th>
                ) : null}
                {showRejectedColumns ? (
                  <th className="px-3 py-2 text-right">Duration rejected</th>
                ) : null}
                <th className="px-3 py-2 text-right">Total duration</th>
                {showRejectedColumns ? (
                  <th className="px-3 py-2">Reject reason</th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={`${r.email}::${r.category}::${r.phoneProvided ?? ""}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{r.name}</div>
                    <div className="text-xs text-slate-500">{r.email}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {r.main ? (
                      <span
                        className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700"
                        title={r.main}
                      >
                        {r.main}
                      </span>
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {r.phoneProvided ? (
                      r.phoneProvided
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{r.category}</td>
                  <td className="px-3 py-2 text-slate-700">
                    {r.personInCharge ? (
                      r.personInCharge
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-700 tabular-nums">
                    {r.submissions}
                    {r.measuredSubmissions !== r.submissions ? (
                      <span className="ml-1 text-xs text-slate-400">
                        ({r.measuredSubmissions} measured)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-center text-slate-700 tabular-nums">
                    {r.dateRange}
                  </td>
                  {showApprovedColumn ? (
                    <td className="px-3 py-2 text-right text-slate-700 tabular-nums">
                      {r.approvedSec > 0 ? (
                        formatDurationVerbose(r.approvedSec)
                      ) : (
                        <span className="text-slate-300">-</span>
                      )}
                    </td>
                  ) : null}
                  {showRejectedColumns ? (
                    <td className="px-3 py-2 text-right text-slate-700 tabular-nums">
                      {r.rejectedSec > 0 ? (
                        formatDurationVerbose(r.rejectedSec)
                      ) : (
                        <span className="text-slate-300">-</span>
                      )}
                    </td>
                  ) : null}
                  <td className="px-3 py-2 text-right font-medium text-slate-900 tabular-nums">
                    {formatDurationVerbose(r.totalSec)}
                  </td>
                  {showRejectedColumns ? (
                    <td className="px-3 py-2 text-slate-700">
                      {r.rejectReason ? (
                        <span
                          className="block max-w-[18rem] truncate"
                          title={r.rejectReason}
                        >
                          {r.rejectReason}
                        </span>
                      ) : (
                        <span className="text-slate-300">-</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
              <tr className="bg-slate-50">
                <td
                  className="px-3 py-2 font-semibold text-slate-700"
                  colSpan={5}
                >
                  Total
                </td>
                <td className="px-3 py-2 text-right font-semibold text-slate-700 tabular-nums">
                  {grandTotalSubmissions}
                </td>
                <td className="px-3 py-2"></td>
                {showApprovedColumn ? (
                  <td className="px-3 py-2 text-right font-semibold text-slate-700 tabular-nums">
                    {grandApprovedSec > 0 ? (
                      formatDurationVerbose(grandApprovedSec)
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                ) : null}
                {showRejectedColumns ? (
                  <td className="px-3 py-2 text-right font-semibold text-slate-700 tabular-nums">
                    {grandRejectedSec > 0 ? (
                      formatDurationVerbose(grandRejectedSec)
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                ) : null}
                <td className="px-3 py-2 text-right font-semibold text-slate-900 tabular-nums">
                  {formatDurationVerbose(grandTotalSec)}
                </td>
                {showRejectedColumns ? (
                  <td className="px-3 py-2"></td>
                ) : null}
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
