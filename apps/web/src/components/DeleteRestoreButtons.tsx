"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Trash2, Undo2 } from "lucide-react";

/**
 * Renders different controls based on the submission's deleted state.
 * - Active submission: a "Delete" button (with a confirm) under a "Danger zone".
 * - Deleted submission: a "Restore" button — returns the submission to the
 *   active list with status preserved.
 */
export function DeleteRestoreButtons({
  submissionId,
  isDeleted,
}: {
  submissionId: string;
  isDeleted: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<null | "delete" | "restore">(null);
  const [error, setError] = useState<string | null>(null);

  async function call(path: "delete" | "restore") {
    if (path === "delete") {
      const ok = window.confirm(
        "Delete this submission? You can restore it later from the Deleted Submissions page.",
      );
      if (!ok) return;
    }
    setError(null);
    setBusy(path);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      let data: { error?: string; devMessage?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        // ignore json parse failures
      }
      if (!res.ok) {
        throw new Error(
          data?.devMessage || data?.error || `Failed (${res.status})`,
        );
      }
      // After delete: send the admin back to the active list. After restore:
      // refresh the detail page in place.
      if (path === "delete") {
        window.location.href = "/admin";
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(null);
    }
  }

  if (isDeleted) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          disabled={busy !== null || isPending}
          onClick={() => call("restore")}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy === "restore" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Undo2 className="h-4 w-4" />
          )}
          Restore submission
        </button>
        {error ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={busy !== null || isPending}
        onClick={() => call("delete")}
        className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
      >
        {busy === "delete" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4" />
        )}
        Delete the submission
      </button>
      <p className="text-xs text-slate-500">
        Soft delete — the submission moves to Deleted Submissions. You can
        restore it later.
      </p>
      {error ? (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}
    </div>
  );
}
