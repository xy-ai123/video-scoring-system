import Link from "next/link";
import { redirect } from "next/navigation";
import { Trash2 } from "lucide-react";
import { prisma } from "@vss/db";
import { SubmissionsTable, type Row } from "@/components/SubmissionsTable";
import { SyncDriveButton } from "@/components/SyncDriveButton";
import { DeleteCorruptButton } from "@/components/DeleteCorruptButton";
import { NewMainBadge } from "@/components/NewMainBadge";
import { getCurrentUser } from "@/lib/auth";
import { getDriveMains } from "@/lib/driveMains";

// Guests are read-only; they get a subset of the UI. Specifically:
//   - rows whose files contain "(clipped)" are hidden entirely
//   - bulk-action / approve / reject / edit / sync / delete buttons
//     are not rendered (`readOnly` prop on SubmissionsTable)
//   - the Clipped/Unclipped filter chip is also hidden (no point in
//     a chip that filters between "shown rows" and "rows that don't
//     exist for me")
const HAS_CLIPPED_SUFFIX_RE = /\(clipped\)/i;

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminHomePage({
  searchParams,
}: {
  // Used for cross-page deep-linking: `/admin?phoneProvided=VPM0166`
  // lands here pre-filtered to that phone. The Phone Inventory page's
  // per-row link uses this. We pass the value down as `initialSearchQuery`
  // and pin searchField to "any" so the Any-column matcher catches it
  // (driveFolderName / phoneProvided / fileName all rolled into one).
  searchParams?: { phoneProvided?: string };
}) {
  const user = await getCurrentUser();
  if (!user) {
    // Static import of `redirect` (not dynamic) so TypeScript sees the
    // `never` return type and narrows `user` to non-null afterwards.
    redirect("/login");
  }
  const isGuest = user.role === "guest";
  const initialSearchQuery = (searchParams?.phoneProvided ?? "").trim();
  // Top-level Drive folder ("VNM", "Hotel 77", …) per immediate-parent
  // folder name. Cached 5min; the Sync Drive button invalidates the
  // cache on success so a brand-new shared-Drive folder shows up as a
  // chip on the very next page load. Graceful degrade to an empty map
  // if the Drive walk fails — every row just shows main="—".
  const mainsPromise = getDriveMains();

  const [submissions, deletedCount, categoryRows, mains] = await Promise.all([
    prisma.submission.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        _count: { select: { files: true } },
        // Pull file metadata so we can (a) compute per-submission totals
        // deduplicated by driveFileId, and (b) render the latest file's
        // name as a clickable Drive link in the Phone Provided cell.
        files: {
          select: {
            driveFileId: true,
            durationSec: true,
            // Failed-probe counter — see schema.prisma. Combined with
            // durationSec below to compute the row's `corrupt` flag.
            durationProbeAttempts: true,
            fileName: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
      // personInCharge is on the Submission model directly, so it's already
      // covered by the default `findMany` selection — no extra select needed.
    }),
    prisma.submission.count({ where: { deletedAt: { not: null } } }),
    // Category history. Distinct values across the *live* submissions,
    // ordered by latest use so the bulk-edit dialog can show "recently
    // used" chips that match the operator's mental model.
    prisma.submission.findMany({
      where: { deletedAt: null, category: { not: "" } },
      select: { category: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    mainsPromise,
  ]);

  // A submission counts as "Clipped" iff one of its files has the
  // literal substring "(clipped)" in its name — i.e. the row IS the
  // clip output, not a raw upload. Earlier we used a more elaborate
  // rule that cross-matched raw filenames against the local clips/
  // folder ("does <stem> (clipped).mp4 exist on disk?"), but that
  // ended up marking raw uploads as Clipped just because their
  // *derivative* output existed on this machine. Operators expect
  // the chip to mean "this row is the clipped video" — same
  // simple definition the /admin/clipping page already uses.
  const HAS_CLIPPED_SUFFIX = /\(clipped\)/i;

  // De-duplicate categories while preserving most-recent-first order.
  const seenCategories = new Set<string>();
  const categoryHistory: string[] = [];
  for (const row of categoryRows) {
    const c = (row.category ?? "").trim();
    if (!c || seenCategories.has(c)) continue;
    seenCategories.add(c);
    categoryHistory.push(c);
    if (categoryHistory.length >= 30) break;
  }

  // Compute per-submission duration with same-video dedup. We pick the first
  // non-null duration per driveFileId so a missing/null measurement on one
  // duplicate row doesn't zero-out a value we have on another.
  function submissionDuration(
    files: { driveFileId: string; durationSec: number | null }[],
  ): { totalSec: number; anyMeasured: boolean } {
    const byDriveId = new Map<string, number | null>();
    for (const f of files) {
      const existing = byDriveId.get(f.driveFileId);
      if (existing == null && f.durationSec != null) {
        byDriveId.set(f.driveFileId, f.durationSec);
      } else if (!byDriveId.has(f.driveFileId)) {
        byDriveId.set(f.driveFileId, f.durationSec);
      }
    }
    let total = 0;
    let measured = false;
    for (const v of byDriveId.values()) {
      if (v != null) {
        total += v;
        measured = true;
      }
    }
    return { totalSec: total, anyMeasured: measured };
  }

  // Resolve each submission's top-level main folder by trying, in
  // order: (1) exact match on driveFolderName, (2) the prefix of
  // driveFolderName before the first '-' or '_', (3) the prefix of
  // the latest file's basename.
  //
  // Why the prefix fallback? Some rows have a driveFolderName like
  // "VPM0167_23MAY" — that's a clip-output subfolder created by the
  // upload pipeline, not a real project folder. The walk-based
  // mapping doesn't know about it. But the *prefix* "VPM0167" IS in
  // the map (its source folder), so we can recover the right main
  // (Hotel 77) without an extra Drive call. Same trick on the
  // filename so rows whose driveFolderName is missing but whose
  // filename starts with a known sub still resolve correctly.
  //
  // Strips path-affecting chars from the filename ('/' or '\') first
  // to mirror what `detect_hands.py` writes when clipping.
  function extractPrefix(s: string | null | undefined): string | null {
    if (!s) return null;
    // Use the part before extension, then before first '-' or '_'.
    const noExt = s.replace(/[\\/]/g, "_").replace(/\.[^.]+$/, "");
    const m = noExt.match(/^([A-Za-z0-9]+)(?:[-_]|$)/);
    return m && m[1] ? m[1] : null;
  }

  function resolveMain(
    driveFolderName: string | null,
    fileName: string | null,
  ): string | null {
    if (driveFolderName) {
      const exact = mains.subFolderNameToMain[driveFolderName];
      if (exact) return exact;
      const folderPrefix = extractPrefix(driveFolderName);
      if (folderPrefix) {
        const viaPrefix = mains.subFolderNameToMain[folderPrefix];
        if (viaPrefix) return viaPrefix;
      }
    }
    const filePrefix = extractPrefix(fileName);
    if (filePrefix) {
      const viaFile = mains.subFolderNameToMain[filePrefix];
      if (viaFile) return viaFile;
    }
    return null;
  }

  // Threshold for "we've conclusively given up measuring this file" —
  // see schema.prisma's VideoFile.durationProbeAttempts doc. After this
  // many failed probes the file is treated as corrupt for UI + delete.
  const CORRUPT_PROBE_THRESHOLD = 3;
  const allRows: Row[] = submissions.map((s) => {
    const { totalSec, anyMeasured } = submissionDuration(s.files);
    // Files are ordered DESC by createdAt above, so [0] is the latest. We
    // surface its (driveFileId, fileName) so the Phone Provided cell can
    // render a Drive link directly.
    const latest = s.files[0];
    // ANY-file rule: submission counts as clipped if at least one of its
    // VideoFile rows has a matching "<stem> (clipped).mp4" on disk.
    const isClipped = s.files.some((f) => HAS_CLIPPED_SUFFIX.test(f.fileName));
    // A submission is "corrupt" when EVERY file is unmeasurable. Two
    // ways a file qualifies as unmeasurable:
    //   1. durationSec === 0 — probe got a junk-zero reading (Drive
    //      metadata had 0, ffprobe head/tail returned 0). Immediate
    //      flag because real 0-second videos are implausible.
    //   2. durationSec is null AND we've tried ≥ CORRUPT_PROBE_THRESHOLD
    //      times — the probe just won't extract a duration. After enough
    //      attempts, treat the file as broken.
    // Empty files array → not corrupt (the row has no file yet; e.g.
    // form submissions that haven't pulled into Drive). All-files match
    // = corrupt. Either-file match = NOT corrupt (the other file might
    // be the live evidence and we can still score off it).
    const corrupt =
      s.files.length > 0 &&
      s.files.every(
        (f) =>
          f.durationSec === 0 ||
          (f.durationSec == null &&
            f.durationProbeAttempts >= CORRUPT_PROBE_THRESHOLD),
      );
    return {
      id: s.id,
      responseId: s.responseId,
      submitterEmail: s.submitterEmail,
      submitterName: s.submitterName,
      category: s.category,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      fileCount: s._count.files,
      durationSec: anyMeasured ? totalSec : null,
      corrupt,
      personInCharge: s.personInCharge,
      phoneProvided: s.phoneProvided,
      rejectReason: s.rejectReason,
      driveFolderName: s.driveFolderName,
      latestFile: latest
        ? { driveFileId: latest.driveFileId, fileName: latest.fileName }
        : null,
      isClipped,
      // Pass the latest file's name as a secondary signal so
      // resolveMain can fall back to filename prefix when the
      // driveFolderName lookup misses (rows parented under a
      // staging or clip-output folder).
      main: resolveMain(s.driveFolderName, latest?.fileName ?? null),
    };
  });

  // Guest filtering — two stacked rules applied server-side:
  //   (1) Hide submissions whose ANY file name contains "(clipped)".
  //       Matches the `isClipped` rule used everywhere else.
  //   (2) NEW: hide submissions whose resolved main doesn't match the
  //       guest's `allowedMain`. Each guest is scoped to one Drive
  //       main (hotel77 → Hotel 77, vnm → VNM, etc.) — anything from
  //       a different main is filtered out here so the dashboard
  //       never even ships those rows to the client.
  //   For admins (or guests with no allowedMain, which shouldn't be
  //   possible after the verifySessionToken guard) both filters are
  //   skipped.
  const guestAllowedMain = isGuest ? user.allowedMain : undefined;
  const rows: Row[] = isGuest
    ? allRows
        .filter((r) => !r.isClipped)
        .filter((r) => !guestAllowedMain || r.main === guestAllowedMain)
    : allRows;

  // Distinct mains that actually appear in the visible rows, plus any
  // mains the Drive walk knows about but that don't have a row yet
  // (rare — happens when an empty top-level folder exists). Sorted so
  // the chip order is stable across page loads.
  const rowMains = new Set<string>();
  for (const r of rows) {
    if (r.main) rowMains.add(r.main);
  }
  for (const m of mains.knownMains) rowMains.add(m);
  // Guests get a knownMains list filtered to ONLY their allowedMain
  // so the chip strip on the dashboard doesn't show Hotel 77 / VNM /
  // other mains they can't see. Admins get the full list.
  const knownMains = Array.from(rowMains)
    .filter((m) => !guestAllowedMain || m === guestAllowedMain)
    .sort((a, b) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Submissions
          </h1>
          <p className="text-sm text-slate-500">
            Review and approve scored video submissions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
          <span>{rows.length} most-recent submissions</span>
          {/* Briefly green-chips any newly-discovered main folders (e.g.
              after sharing a new top-level Drive folder with the SA).
              Per-browser memory via localStorage so each admin sees the
              flag once. Renders nothing on first visit + zero diff. */}
          <NewMainBadge knownMains={knownMains} />
          {/* Admin-only header buttons. Guests don't see Sync Drive
              (writes new submissions), Delete Corrupt (writes
              soft-deletes), or the Deleted Submissions link (would
              navigate to /admin/trash which middleware blocks for
              guests anyway). Hiding the entry points avoids confusing
              dead-end clicks. */}
          {!isGuest ? (
            <>
              <SyncDriveButton />
              <DeleteCorruptButton />
              <Link
                href="/admin/trash"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Deleted Submissions{deletedCount > 0 ? ` (${deletedCount})` : ""}
              </Link>
            </>
          ) : null}
        </div>
      </div>

      <SubmissionsTable
        rows={rows}
        categoryHistory={categoryHistory}
        knownMains={knownMains}
        initialSearchQuery={initialSearchQuery}
        readOnly={isGuest}
      />
    </div>
  );
}
