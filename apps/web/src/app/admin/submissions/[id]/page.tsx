import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@vss/db";
import { StatusBadge } from "@/components/StatusBadge";
import { ApproveRejectButtons } from "@/components/ApproveRejectButtons";
import { DeleteRestoreButtons } from "@/components/DeleteRestoreButtons";
import { EditPicButton } from "@/components/EditPicButton";
import { FormattedDate } from "@/components/FormattedDate";
import { getCurrentUser } from "@/lib/auth";
import { getDriveMains } from "@/lib/driveMains";
import { formatDurationSec, formatDurationVerbose } from "@/lib/duration";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SubmissionDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const isGuest = user.role === "guest";
  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    include: {
      files: {
        include: { scores: true },
        orderBy: { createdAt: "asc" },
      },
      scores: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!submission) notFound();

  // Per-main guest scope: if the viewer is a guest, resolve THIS
  // submission's main and reject (404) when it doesn't match the
  // guest's allowedMain. The dashboard's list filter ALREADY hides
  // these — this check is defense-in-depth for anyone constructing a
  // URL by hand. Admins skip the check entirely.
  if (isGuest && user.allowedMain) {
    const mains = await getDriveMains();
    // Same two-step resolve as /admin/page.tsx: exact lookup first,
    // then prefix fallback on driveFolderName, then on the latest
    // file's name. Returns null when nothing resolves — counts as
    // "different main" so out-of-scope submissions stay out of reach.
    function extractPrefix(s: string | null | undefined): string | null {
      if (!s) return null;
      const noExt = s.replace(/[\\/]/g, "_").replace(/\.[^.]+$/, "");
      const m = noExt.match(/^([A-Za-z0-9]+)(?:[-_]|$)/);
      return m && m[1] ? m[1] : null;
    }
    function resolveMain(): string | null {
      if (submission!.driveFolderName) {
        const exact = mains.subFolderNameToMain[submission!.driveFolderName];
        if (exact) return exact;
        const folderPrefix = extractPrefix(submission!.driveFolderName);
        if (folderPrefix) {
          const viaPrefix = mains.subFolderNameToMain[folderPrefix];
          if (viaPrefix) return viaPrefix;
        }
      }
      const latestFile = submission!.files[0];
      const filePrefix = extractPrefix(latestFile?.fileName ?? null);
      if (filePrefix) {
        const viaFile = mains.subFolderNameToMain[filePrefix];
        if (viaFile) return viaFile;
      }
      return null;
    }
    const submissionMain = resolveMain();
    if (submissionMain !== user.allowedMain) {
      notFound();
    }
  }

  const isDeleted = Boolean(submission.deletedAt);
  // Score-blur policy: guests see blurred score numbers until an admin
  // has formally approved or rejected the submission. Admins always see
  // raw scores. SCORED means "AI pipeline finished, awaiting human
  // decision" — that's the case we want to hide from guests so guests
  // don't form opinions before the admin reviews.
  // PENDING / SCORING / FAILED don't have scores yet, so the blur is
  // moot for them; this flag only matters when sc.value is actually
  // present below.
  const blurScores = isGuest && submission.status === "SCORED";

  // Sum of per-file durations, deduplicated by driveFileId so a duplicate
  // VideoFile row pointing at the same Drive object isn't double-counted.
  // We pick the first non-null durationSec we see per driveFileId; rows with
  // a null measurement don't zero-out a value we got from another row.
  const seenDriveIds = new Map<string, number | null>();
  for (const f of submission.files) {
    const existing = seenDriveIds.get(f.driveFileId);
    if (!seenDriveIds.has(f.driveFileId)) {
      seenDriveIds.set(f.driveFileId, f.durationSec);
    } else if (existing == null && f.durationSec != null) {
      seenDriveIds.set(f.driveFileId, f.durationSec);
    }
  }
  let submissionDurationSec = 0;
  let anyFileHasDuration = false;
  for (const v of seenDriveIds.values()) {
    if (v != null) {
      submissionDurationSec += v;
      anyFileHasDuration = true;
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={isDeleted ? "/admin/trash" : "/admin"}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          ← Back to {isDeleted ? "deleted submissions" : "submissions"}
        </Link>
      </div>

      {isDeleted ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <strong className="font-semibold">Deleted.</strong> Removed{" "}
          <FormattedDate iso={submission.deletedAt as Date} />
          {submission.deletedBy ? (
            <>
              {" by "}
              <span className="font-medium">{submission.deletedBy}</span>
            </>
          ) : null}
          . Approve / Reject and notes editing are disabled until you restore
          this submission.
        </div>
      ) : null}

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight">
            {submission.submitterName}
          </h1>
          <p className="break-all text-sm text-slate-500">
            {submission.submitterEmail}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            Phone Provided:{" "}
            {/* Match the dashboard list cell's logic: when the form's
                phoneProvided value is missing but the submission has a
                Drive file, show the Drive folder name (i.e.
                `category` — e.g. "15 May", "VPM1060") as a link that
                opens the latest file in Drive. Operators expect this
                column to be the "where did this video come from"
                pointer, not a hard-coded form field. */}
            {(() => {
              if (submission.phoneProvided) {
                return (
                  <span className="text-slate-900">
                    {submission.phoneProvided}
                  </span>
                );
              }
              // Files are ordered ASC by createdAt in the query above,
              // so the latest one is the last element. .at(-1) returns
              // undefined for an empty list — safe to chain.
              const latest = submission.files.at(-1);
              // Prefer the immutable `driveFolderName` (recorded at
              // ingest) over the now-editable `category` so this label
              // stays stable even after an operator renames the
              // category. Falls back to category for legacy rows.
              const label =
                submission.driveFolderName?.trim() ||
                submission.category?.trim();
              if (latest && label) {
                return (
                  <a
                    href={`https://drive.google.com/file/d/${latest.driveFileId}/view`}
                    target="_blank"
                    rel="noreferrer"
                    title={latest.fileName}
                    className="text-brand-600 hover:underline"
                  >
                    {label}
                  </a>
                );
              }
              return <span className="text-slate-300">-</span>;
            })()}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            Category: <span className="text-slate-900">{submission.category}</span>
          </p>
          <p
            className="mt-1 break-all font-mono text-xs text-slate-400"
            title={submission.id}
          >
            ID: {submission.id}
          </p>
        </div>
        <div className="flex items-center gap-2 sm:flex-col sm:items-end sm:gap-1">
          <StatusBadge status={submission.status} />
          {/* Person in Charge: typed by an admin in the approve/reject dialog.
              Sits right beside / under the status badge so the operator can
              see at a glance who took the decision. Only renders for decided
              submissions; otherwise nothing's been recorded yet. */}
          {submission.personInCharge ? (
            <span
              className="text-xs text-slate-500"
              title="Person who took the approve/reject decision"
            >
              Person in Charge:{" "}
              <span className="font-medium text-slate-700">
                {submission.personInCharge}
              </span>
            </span>
          ) : null}
          <span className="text-xs text-slate-400">
            Submitted <FormattedDate iso={submission.createdAt} />
          </span>
        </div>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">Files</h2>
          <div className="text-xs text-slate-500">
            Total video duration:{" "}
            <span className="font-medium text-slate-900">
              {anyFileHasDuration
                ? formatDurationVerbose(submissionDurationSec)
                : "—"}
            </span>
          </div>
        </div>
        <ul className="mt-3 divide-y divide-slate-100">
          {submission.files.map((f) => (
            <li key={f.id} className="py-3">
              <div className="flex items-center justify-between">
                <div>
                  <a
                    href={`https://drive.google.com/file/d/${f.driveFileId}/view`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-brand-600 hover:underline"
                  >
                    {f.fileName}
                  </a>
                  <div className="text-xs text-slate-500">
                    {f.mimeType ?? "unknown"} · scoring: {f.scoringStatus}
                    {f.durationSec != null
                      ? ` · duration: ${formatDurationSec(f.durationSec)}`
                      : ""}
                    {f.scoringError ? ` · error: ${f.scoringError}` : ""}
                  </div>
                </div>
              </div>
              {f.scores.length > 0 ? (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {f.scores.map((sc) => (
                      <div
                        key={sc.id}
                        className="rounded-md bg-slate-50 px-3 py-2"
                      >
                        {/* Metric label (OVERALL / CLARITY / ENGAGEMENT)
                            is ALWAYS clear — the user wanted only the
                            numbers blurred, not the labels. */}
                        <div className="text-xs uppercase tracking-wide text-slate-500">
                          {sc.metric}
                        </div>
                        {/* Score value: blurred for guests while status
                            is still SCORED. select-none + aria-hidden
                            discourages copy-paste/screen-reader leak of
                            the blurred value (it's still in the DOM —
                            the blur is a UX cue, not a security barrier).
                            Title tooltip explains why on hover. */}
                        <div
                          className={
                            "text-sm font-semibold text-slate-900 " +
                            (blurScores
                              ? "blur-sm select-none pointer-events-none"
                              : "")
                          }
                          aria-hidden={blurScores || undefined}
                          title={
                            blurScores
                              ? "Score hidden until an admin approves or rejects this submission."
                              : undefined
                          }
                        >
                          {sc.value.toFixed(3)}
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Guest-only footnote explaining WHY the score
                      numbers are blurred. Sits directly under the
                      score grid for this file so a multi-file
                      submission gets one footnote per blurred grid
                      (the message stays attached to the thing it
                      describes). Admins and decided submissions
                      never see this. */}
                  {blurScores ? (
                    <p className="mt-2 text-xs italic text-slate-500">
                      *Scores will be shown once the admin has approved or
                      rejected the submission.
                    </p>
                  ) : null}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {/* Decision section: hidden entirely for guests (they have no
          authority to approve / reject / set PIC / take notes). Also
          hidden when the submission is in the trash — same as before.
          Admin users see this exactly as they did before. */}
      {isDeleted || isGuest ? null : (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Decision</h2>
            {/* Standalone PIC editor — sits on the right of the Decision
                section header so it's discoverable without scrolling past
                the Approve/Reject buttons. Doesn't touch the submission's
                status; only updates personInCharge. */}
            <EditPicButton
              submissionId={submission.id}
              initialPersonInCharge={submission.personInCharge}
            />
          </div>
          <div className="mt-3">
            <ApproveRejectButtons
              submissionId={submission.id}
              status={submission.status}
              initialNotes={submission.notes}
              initialPersonInCharge={submission.personInCharge}
              initialRejectReason={submission.rejectReason}
            />
          </div>
          {submission.reviewedBy ? (
            <p className="mt-3 text-xs text-slate-400">
              Last reviewed by {submission.reviewedBy}
              {submission.reviewedAt ? (
                <>
                  {" at "}
                  <FormattedDate iso={submission.reviewedAt} />
                </>
              ) : null}
            </p>
          ) : null}
        </section>
      )}

      {/* Danger zone (Delete / Restore): admin-only. Guests can't
          mutate submissions, so the entire section is hidden. */}
      {isGuest ? null : (
        <section
          className={
            "rounded-xl border p-5 " +
            (isDeleted
              ? "border-emerald-200 bg-emerald-50/50"
              : "border-rose-200 bg-rose-50/30")
          }
        >
          <h2 className="text-sm font-semibold text-slate-900">
            {isDeleted ? "Recover" : "Danger zone"}
          </h2>
          <div className="mt-3">
            <DeleteRestoreButtons
              submissionId={submission.id}
              isDeleted={isDeleted}
            />
          </div>
        </section>
      )}
    </div>
  );
}
