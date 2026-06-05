import clsx from "clsx";
import type { SubmissionStatus } from "@vss/db";

const STYLES: Record<SubmissionStatus, string> = {
  PENDING: "bg-slate-100 text-slate-700 ring-slate-200",
  SCORING: "bg-blue-50 text-blue-700 ring-blue-200",
  SCORED: "bg-amber-50 text-amber-800 ring-amber-200",
  APPROVED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-200",
  FAILED: "bg-red-100 text-red-800 ring-red-300",
};

export function StatusBadge({ status }: { status: SubmissionStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        STYLES[status],
      )}
    >
      {status}
    </span>
  );
}
