"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, UserCog } from "lucide-react";

/**
 * Standalone "Edit PIC" button + modal on the submission detail page. Lets
 * an admin set or change the Person in Charge on a submission *without*
 * approving or rejecting (the approve/reject buttons still record PIC as
 * part of their own flow — this just covers the standalone case).
 *
 * Self-contained: owns its dialog state, posts to /api/submissions/[id]/pic,
 * then triggers a server refresh so the page header and dashboard column
 * pick up the new value.
 */
export function EditPicButton({
  submissionId,
  initialPersonInCharge,
}: {
  submissionId: string;
  initialPersonInCharge: string | null;
}) {
  const router = useRouter();
  const [isRefreshPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialPersonInCharge ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setName(initialPersonInCharge ?? "");
    setOpen(true);
  }
  function closeDialog() {
    if (busy) return; // don't drop the request mid-flight
    setOpen(false);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/pic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personInCharge: name }),
      });
      let data: { error?: string; devMessage?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        /* fall through to status-text message */
      }
      if (!res.ok) {
        throw new Error(
          data?.devMessage ||
            data?.error ||
            `Request failed (${res.status})`,
        );
      }
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={isRefreshPending}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        title={
          initialPersonInCharge
            ? `Person in Charge: ${initialPersonInCharge}. Click to edit.`
            : "Set Person in Charge for this submission"
        }
      >
        <UserCog className="h-4 w-4" />
        {initialPersonInCharge ? "Edit PIC" : "Set PIC"}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="vss-pic-edit-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDialog();
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3
              id="vss-pic-edit-title"
              className="text-base font-semibold text-slate-900"
            >
              {initialPersonInCharge ? "Edit Person in Charge" : "Set Person in Charge"}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              This name appears on the submission detail page and the
              dashboard PIC column. Leave blank and confirm to clear it.
            </p>

            <label
              htmlFor="vss-pic-edit-name"
              className="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Person in Charge
            </label>
            <input
              id="vss-pic-edit-name"
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                } else if (e.key === "Escape") {
                  closeDialog();
                }
              }}
              maxLength={120}
              placeholder="e.g. Wei Ling"
              className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />

            {error ? (
              <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeDialog}
                disabled={busy}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 disabled:hover:bg-brand-600"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UserCog className="h-4 w-4" />
                )}
                Save PIC
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

