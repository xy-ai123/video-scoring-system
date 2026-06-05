"use client";

import { Bug } from "lucide-react";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

type CorruptRow = {
  id: string;
  submitterEmail: string;
  submitterName: string;
  fileNames: string[];
};

/**
 * Header-strip button that finds + soft-deletes every Submission whose
 * source videos we've conclusively failed to measure. Uses /api/admin/
 * delete-corrupt — GET returns the list (drives the confirm dialog),
 * POST performs the soft delete. Both rules live server-side; this
 * component only renders the UX.
 *
 * Two-step flow:
 *   1. Click button → GET /api/admin/delete-corrupt to count + preview.
 *   2. Show window.confirm with up to 12 filenames + the total. On OK,
 *      POST to do the delete. On Cancel, no-op.
 * After a successful delete: router.refresh() so the table re-renders
 * with the orphans gone.
 */
export function DeleteCorruptButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [lastDeleted, setLastDeleted] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    if (busy) return;
    setError(null);
    setLastDeleted(null);
    setBusy(true);
    try {
      // 1. Preview.
      const r = await fetch("/api/admin/delete-corrupt", { cache: "no-store" });
      if (!r.ok) {
        setError(`Preview failed: HTTP ${r.status}`);
        return;
      }
      const preview = (await r.json()) as {
        corrupt: CorruptRow[];
        count: number;
      };
      if (preview.count === 0) {
        // Nothing to do — give a positive ack rather than silent.
        setLastDeleted(0);
        return;
      }
      // 2. Confirm with up to 12 filenames in the dialog.
      const sample = preview.corrupt
        .flatMap((c) => c.fileNames)
        .slice(0, 12)
        .map((n) => `  • ${n}`)
        .join("\n");
      const more =
        preview.count > 12 ? `\n  …and ${preview.count - 12} more` : "";
      const ok = window.confirm(
        `Soft-delete ${preview.count} corrupt submission${
          preview.count === 1 ? "" : "s"
        }?\n\n` +
          "These are submissions whose every file has no measurable " +
          "duration AND we've already tried ffprobe and failed " +
          "(typically MP4s missing their moov atom from a partial " +
          "upload).\n\n" +
          "Filenames:\n" +
          sample +
          more +
          "\n\nThey'll move to Deleted Submissions where you can " +
          "restore them if you re-upload the source.",
      );
      if (!ok) return;
      // 3. Delete.
      const del = await fetch("/api/admin/delete-corrupt", {
        method: "POST",
      });
      if (!del.ok) {
        setError(`Delete failed: HTTP ${del.status}`);
        return;
      }
      const result = (await del.json()) as { deleted: number };
      setLastDeleted(result.deleted);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, router]);

  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        title="Find and soft-delete every submission whose files are all unmeasurable (corrupt MP4s — no moov atom, ffprobe already tried)"
        className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-white px-2.5 py-1 font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
      >
        <Bug className="h-3.5 w-3.5" />
        {busy ? "Checking…" : "Delete corrupt"}
      </button>
      {lastDeleted != null ? (
        <span
          className={lastDeleted > 0 ? "text-rose-700" : "text-slate-500"}
          title="Result of the last Delete-corrupt run"
        >
          {lastDeleted === 0
            ? "no corrupt rows"
            : `deleted ${lastDeleted}`}
        </span>
      ) : null}
      {error ? (
        <span className="text-rose-600" title={error}>
          failed: {error}
        </span>
      ) : null}
    </div>
  );
}
