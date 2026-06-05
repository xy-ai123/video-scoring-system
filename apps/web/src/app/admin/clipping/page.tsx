import Link from "next/link";
import { prisma } from "@vss/db";
import { ClippingDashboard } from "./ClippingDashboard";
import { getCurrentAdmin } from "@/lib/auth";
import { listClips } from "@/lib/clipping";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Dashboard 1 — auto-clipping view.
 *
 * Left pane:  Unclipped videos
 *   - Google Form submissions that haven't been processed yet
 *     (status = PENDING/SCORING — we look those up server-side)
 *   - Raw files in ~/robot-video-pipeline/incoming/ (fetched client-side
 *     because the path is filesystem-only)
 *
 * Right pane: Clipped MP4s (read from clips/ + pipeline.db).
 *
 * The "Run clipping now" button POSTs /api/clipping/run, which shells out
 * to pull_from_drive.py -> detect_hands.py -> upload_clips_to_drive.py.
 */
export default async function ClippingPage() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }

  // Every non-deleted submission with at least one file. Whether a row
  // is "unclipped" is determined client-side by checking if a matching
  // <stem> (clipped).mp4 exists on disk (isFormClipped). Status here is
  // about scoring (PENDING/SCORING/SCORED) — it's orthogonal to whether
  // the video has been clipped, so it's NOT used as a filter. (Earlier
  // this query had `status: { in: ["PENDING", "SCORING"] }`, but that
  // hid the 40+ raw videos that the worker auto-marks as SCORED after
  // ingest — they never appeared in the Unclipped pane even though
  // they had no clip on disk.)
  const pending = await prisma.submission.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      files: {
        select: { driveFileId: true, fileName: true, durationSec: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  // Pre-filter on the server so the first paint is already correct —
  // otherwise every FORM row flashes briefly before the client fetches
  // /api/clips and the React-side filter removes the already-clipped
  // ones. The dashboard's client-side filter still runs (defense in
  // depth, and it handles clips that appear later in the same session),
  // but doing it here too gives the user a clean initial render.
  //
  // Rules (matching the dashboard's isFormClipped + isClippedName):
  //   1. Hide rows whose name contains "(clipped)" — they're clip
  //      output that doesn't need clipping again.
  //   2. Hide rows whose sanitized stem has a corresponding
  //      "<stem> (clipped).mp4" on disk — already clipped.
  // Sanitization: detect_hands.py replaces `/` and `\` with `_` when
  // writing the clip, so we do the same when computing the lookup key.
  const clipNameSet = new Set<string>(
    listClips().map((c) => c.fileName.toLowerCase()),
  );
  function hasClipOnDisk(rawFileName: string | null): boolean {
    if (!rawFileName) return false;
    const safe = rawFileName.replace(/[\\/]/g, "_");
    const m = safe.match(/^(.+)\.(?:mp4|mov|avi|mkv)$/i);
    if (!m) return false;
    return clipNameSet.has(`${m[1]} (clipped).mp4`.toLowerCase());
  }
  const CLIPPED_IN_NAME = /\(clipped\)/i;

  const formSubmissions = pending
    .map((s) => {
      const f = s.files[0];
      return {
        id: s.id,
        submitterName: s.submitterName,
        submitterEmail: s.submitterEmail,
        category: s.category,
        createdAt: s.createdAt.toISOString(),
        status: s.status,
        fileName: f?.fileName ?? null,
        driveFileId: f?.driveFileId ?? null,
        durationSec: f?.durationSec ?? null,
      };
    })
    .filter(
      (s) =>
        !(s.fileName && CLIPPED_IN_NAME.test(s.fileName)) &&
        !hasClipOnDisk(s.fileName),
    );

  return (
    <div className="space-y-4">
      <header>
        {/* Small back-link to the main Submissions dashboard, matching
            the same pattern used on /admin/analytics. Operators bounce
            between these two pages constantly — keeping the link in
            the same place on every sub-page means they never have to
            hunt for it. */}
        <Link
          href="/admin"
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          ← Back to submissions
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Clipping pipeline
        </h1>
        <p className="text-sm text-slate-500">
          Pull raw videos from Drive + Forms, auto-clip hand-activity
          segments with ffmpeg, and push CVAT-ready MP4s to the hand-off
          folder.
        </p>
      </header>
      <ClippingDashboard formSubmissions={formSubmissions} />
    </div>
  );
}
