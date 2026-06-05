"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ChevronRight, Loader2, Undo2 } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import { FormattedDate } from "./FormattedDate";
import type { SubmissionStatus } from "@vss/db";

export type TrashRow = {
  id: string;
  submitterEmail: string;
  submitterName: string;
  category: string;
  status: SubmissionStatus;
  createdAt: string;
  deletedAt: string;
  deletedBy: string | null;
  fileCount: number;
};

export function TrashTable({ rows }: { rows: TrashRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restore(id: string) {
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch(`/api/submissions/${id}/restore`, {
        method: "POST",
      });
      let data: { error?: string; devMessage?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        // ignore
      }
      if (!res.ok) {
        throw new Error(
          data?.devMessage || data?.error || `Failed (${res.status})`,
        );
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
        No deleted submissions.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {/* Mobile cards */}
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li
            key={r.id}
            className="rounded-xl border border-slate-200 bg-white"
          >
            <div className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-900">
                    {r.submitterName}
                  </div>
                  <div className="truncate text-xs text-slate-500">
                    {r.submitterEmail}
                  </div>
                </div>
                <StatusBadge status={r.status} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span className="text-slate-700">{r.category}</span>
                <span>·</span>
                <span>
                  {r.fileCount} {r.fileCount === 1 ? "file" : "files"}
                </span>
              </div>
              <div className="text-xs text-rose-700">
                Deleted <FormattedDate iso={r.deletedAt} />
                {r.deletedBy ? ` by ${r.deletedBy}` : ""}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={busyId !== null || isPending}
                  onClick={() => restore(r.id)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busyId === r.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Undo2 className="h-3.5 w-3.5" />
                  )}
                  Restore
                </button>
                <Link
                  href={`/admin/submissions/${r.id}`}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  View <ChevronRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Desktop table */}
      <div className="hidden md:block">
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Submitter</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Deleted</th>
                <th className="px-4 py-2.5">By</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">
                      {r.submitterName}
                    </div>
                    <div className="text-xs text-slate-500">
                      {r.submitterEmail}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{r.category}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    <FormattedDate iso={r.deletedAt} />
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.deletedBy ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busyId !== null || isPending}
                        onClick={() => restore(r.id)}
                        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {busyId === r.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Undo2 className="h-3.5 w-3.5" />
                        )}
                        Restore
                      </button>
                      <Link
                        href={`/admin/submissions/${r.id}`}
                        className="text-xs font-medium text-brand-600 hover:underline"
                      >
                        View
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
