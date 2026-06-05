"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, X, Loader2, Save, Send } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import type { SubmissionStatus } from "@vss/db";

type Props = {
  submissionId: string;
  status: SubmissionStatus;
  initialNotes: string | null;
  /** Last value of Submission.personInCharge — used to pre-fill the dialog
   *  on re-approve / re-reject so the admin doesn't have to retype. */
  initialPersonInCharge: string | null;
  /** Last value of Submission.rejectReason — used to pre-fill the reject
   *  dialog when re-rejecting (e.g. fixing a typo in the reason). */
  initialRejectReason: string | null;
};

export function ApproveRejectButtons({
  submissionId,
  status,
  initialNotes,
  initialPersonInCharge,
  initialRejectReason,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<null | "approve" | "reject" | "notes" | "resend">(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<SubmissionStatus | null>(null);
  const [notes, setNotes] = useState<string>(initialNotes ?? "");
  // Person-in-Charge dialog state. `pendingAction === null` means the modal
  // is closed; setting it to "approve" or "reject" opens the modal and
  // remembers which action to fire once the admin confirms a name.
  const [pendingAction, setPendingAction] = useState<
    null | "approve" | "reject"
  >(null);
  const [pendingName, setPendingName] = useState<string>(
    initialPersonInCharge ?? "",
  );
  // Reject-only second field. Pre-fills from the row's stored reason when
  // re-rejecting (e.g. fixing a typo) so the admin doesn't retype.
  const [pendingReason, setPendingReason] = useState<string>(
    initialRejectReason ?? "",
  );

  const effective = optimistic ?? status;
  const decided = effective === "APPROVED" || effective === "REJECTED";
  const failedScoring = effective === "FAILED";
  const notesDirty = (notes ?? "") !== (initialNotes ?? "");

  async function call(
    path: "approve" | "reject" | "notes" | "resend-approval" | "resend-rejection",
    payload: object,
    opts: {
      optimisticStatus?: SubmissionStatus | null;
      toastOnSuccess?: string;
      busyKey?: "approve" | "reject" | "notes" | "resend";
    } = {},
  ) {
    setError(null);
    setInfo(null);
    setBusy(opts.busyKey ?? (path as "approve" | "reject" | "notes"));
    if (opts.optimisticStatus !== undefined) {
      setOptimistic(opts.optimisticStatus);
    }
    try {
      const res = await fetch(`/api/submissions/${submissionId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data: { error?: string; devMessage?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        // ignore JSON parse failures; we'll fall back to status text
      }
      if (!res.ok) {
        throw new Error(
          data?.devMessage ||
            data?.error ||
            `Request failed (${res.status})`,
        );
      }
      if (opts.toastOnSuccess) setInfo(opts.toastOnSuccess);
      startTransition(() => router.refresh());
    } catch (err) {
      setOptimistic(null);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(null);
    }
  }

  // Open the Person-in-Charge dialog. The actual API call happens in
  // confirmDecision() after the admin enters a name.
  function openApproveDialog() {
    setError(null);
    setInfo(null);
    setPendingName(initialPersonInCharge ?? pendingName);
    setPendingAction("approve");
  }
  function openRejectDialog() {
    setError(null);
    setInfo(null);
    setPendingName(initialPersonInCharge ?? pendingName);
    setPendingReason(initialRejectReason ?? pendingReason);
    setPendingAction("reject");
  }
  function cancelDialog() {
    if (busy === "approve" || busy === "reject") return; // don't drop while in-flight
    setPendingAction(null);
  }

  async function confirmDecision() {
    const trimmed = pendingName.trim();
    if (trimmed.length === 0) {
      setError("Please enter your name as Person in Charge before confirming.");
      return;
    }
    if (pendingAction === "approve") {
      await call(
        "approve",
        { notes: notes.trim() || undefined, personInCharge: trimmed },
        {
          optimisticStatus: "APPROVED",
          toastOnSuccess:
            effective === "APPROVED"
              ? `Saved (Person in Charge: ${trimmed}).`
              : `Approved by ${trimmed} — submitter will be emailed.`,
        },
      );
    } else if (pendingAction === "reject") {
      // Reject also requires a non-empty reason. Block at the dialog so
      // the user gets immediate feedback instead of a 400 from the API.
      const trimmedReason = pendingReason.trim();
      if (trimmedReason.length === 0) {
        setError("Please enter a reject reason before confirming.");
        return;
      }
      await call(
        "reject",
        {
          notes: notes.trim() || undefined,
          personInCharge: trimmed,
          rejectReason: trimmedReason,
        },
        {
          optimisticStatus: "REJECTED",
          toastOnSuccess: `Rejected by ${trimmed} (reason: ${trimmedReason.slice(0, 80)}${trimmedReason.length > 80 ? "…" : ""}).`,
        },
      );
    }
    setPendingAction(null);
  }

  async function handleSaveNotes() {
    await call("notes", { notes }, { toastOnSuccess: "Notes saved." });
  }

  async function handleResendApproval() {
    await call(
      "resend-approval",
      {},
      {
        busyKey: "resend",
        toastOnSuccess: "Approval email queued — submitter will be emailed shortly.",
      },
    );
  }

  async function handleResendRejection() {
    await call(
      "resend-rejection",
      {},
      {
        busyKey: "resend",
        toastOnSuccess: "Rejection email queued — submitter will be emailed shortly.",
      },
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>Current decision:</span>
        <StatusBadge status={effective} />
        {decided ? (
          <span className="text-slate-400">
            (you can still flip the decision below)
          </span>
        ) : null}
      </div>

      <textarea
        placeholder="Optional notes (visible only to admins)…"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        rows={3}
      />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null || isPending || effective === "APPROVED"}
          onClick={openApproveDialog}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50 disabled:hover:bg-emerald-600"
        >
          {busy === "approve" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {effective === "REJECTED"
            ? "Switch to Approved (and email)"
            : effective === "APPROVED"
              ? "Approved"
              : "Approve & email submitter"}
        </button>

        <button
          type="button"
          disabled={busy !== null || isPending || effective === "REJECTED"}
          onClick={openRejectDialog}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy === "reject" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <X className="h-4 w-4" />
          )}
          {effective === "APPROVED"
            ? "Switch to Rejected"
            : effective === "REJECTED"
              ? "Rejected"
              : "Reject"}
        </button>

        <button
          type="button"
          disabled={busy !== null || isPending || !notesDirty}
          onClick={handleSaveNotes}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy === "notes" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save notes
        </button>

        {effective === "APPROVED" ? (
          <button
            type="button"
            disabled={busy !== null || isPending}
            onClick={handleResendApproval}
            title="Re-send the approval email to the submitter (no sheet row will be added)"
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
          >
            {busy === "resend" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Resend approval email
          </button>
        ) : null}

        {effective === "REJECTED" ? (
          <button
            type="button"
            disabled={busy !== null || isPending}
            onClick={handleResendRejection}
            title="Re-send the rejection email to the submitter (no sheet row will be added)"
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
          >
            {busy === "resend" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Resend rejection email
          </button>
        ) : null}
      </div>

      {failedScoring ? (
        <p className="text-xs text-amber-700">
          Scoring failed for this submission. You can still record a manual
          decision and notes above.
        </p>
      ) : null}

      {error ? (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {info ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {info}
        </div>
      ) : null}

      {pendingAction !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="vss-pic-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={(e) => {
            // Click on the backdrop = cancel. Clicks on the dialog box itself
            // stop propagation so they don't dismiss.
            if (e.target === e.currentTarget) cancelDialog();
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3
              id="vss-pic-dialog-title"
              className="text-base font-semibold text-slate-900"
            >
              {pendingAction === "approve"
                ? "Approve submission"
                : "Reject submission"}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Enter your name as the Person in Charge. This is recorded with
              the decision and shown on the submission detail page.
            </p>

            <label
              htmlFor="vss-pic-name"
              className="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Person in Charge
            </label>
            <input
              id="vss-pic-name"
              type="text"
              autoFocus
              value={pendingName}
              onChange={(e) => setPendingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void confirmDecision();
                } else if (e.key === "Escape") {
                  cancelDialog();
                }
              }}
              maxLength={120}
              placeholder="e.g. Wei Ling"
              className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />

            {pendingAction === "reject" ? (
              <>
                <label
                  htmlFor="vss-reject-reason"
                  className="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500"
                >
                  Reject reason
                </label>
                <textarea
                  id="vss-reject-reason"
                  value={pendingReason}
                  onChange={(e) => setPendingReason(e.target.value)}
                  // Cmd/Ctrl+Enter submits (textareas otherwise insert a
                  // newline on plain Enter, which the admin will likely
                  // want when typing a multi-line reason). Escape still
                  // cancels.
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void confirmDecision();
                    } else if (e.key === "Escape") {
                      cancelDialog();
                    }
                  }}
                  maxLength={2000}
                  rows={3}
                  placeholder="e.g. Video is blurry / wrong category / phone not visible"
                  className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <p className="mt-1 text-xs text-slate-400">
                  Required. Shown in the dashboard&apos;s &ldquo;Reject
                  Reason&rdquo; column and the export PDF.
                </p>
              </>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelDialog}
                disabled={busy === "approve" || busy === "reject"}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDecision()}
                disabled={
                  busy === "approve" ||
                  busy === "reject" ||
                  pendingName.trim().length === 0 ||
                  (pendingAction === "reject" &&
                    pendingReason.trim().length === 0)
                }
                className={
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white shadow-sm disabled:opacity-50 " +
                  (pendingAction === "approve"
                    ? "bg-emerald-600 hover:bg-emerald-700 disabled:hover:bg-emerald-600"
                    : "bg-rose-600 hover:bg-rose-700 disabled:hover:bg-rose-600")
                }
              >
                {busy === pendingAction ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : pendingAction === "approve" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <X className="h-4 w-4" />
                )}
                {pendingAction === "approve"
                  ? "Confirm approve"
                  : "Confirm reject"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
