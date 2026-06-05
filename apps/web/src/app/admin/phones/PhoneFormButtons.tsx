"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Loader2, ListPlus, Pencil, Plus, X } from "lucide-react";

/**
 * Two related buttons on the /admin/phones page, sharing one modal:
 *   - `AddPhoneButton` opens a blank form (POST /api/phones).
 *   - `EditPhoneButton` is rendered per-row, pre-fills the form (PATCH).
 *
 * Kept in one file so the modal markup isn't duplicated. Each button owns
 * its own open/closed state but renders the same `<PhoneDialog>` portal.
 */

export type PhoneRow = {
  internal: string;
  modelNumber: string;
  phoneSerial: string | null;
  imei: string | null;
  imei2: string | null;
  rentedOut: boolean;
  /** ISO date string ("2026-05-20") of when the phone was rented out. Null
   *  when the operator hasn't recorded a rental date yet. */
  rentedAt: string | null;
  assignedUser: string | null;
  notes: string | null;
};

type Mode = "create" | "edit";

function PhoneDialog({
  mode,
  initial,
  onClose,
  onSubmitted,
}: {
  mode: Mode;
  initial: PhoneRow | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [internal, setInternal] = useState(initial?.internal ?? "");
  const [modelNumber, setModelNumber] = useState(initial?.modelNumber ?? "");
  const [phoneSerial, setPhoneSerial] = useState(initial?.phoneSerial ?? "");
  const [imei, setImei] = useState(initial?.imei ?? "");
  const [imei2, setImei2] = useState(initial?.imei2 ?? "");
  const [rentedOut, setRentedOut] = useState(initial?.rentedOut ?? false);
  // <input type="date"> wants a YYYY-MM-DD string. Strip any time component
  // from the server's ISO so the picker initializes correctly.
  const [rentedAt, setRentedAt] = useState(
    initial?.rentedAt ? initial.rentedAt.slice(0, 10) : "",
  );
  const [assignedUser, setAssignedUser] = useState(initial?.assignedUser ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const payload =
        mode === "create"
          ? {
              internal: internal.trim(),
              modelNumber,
              phoneSerial,
              imei,
              imei2,
              rentedOut,
              rentedAt,
              assignedUser,
              notes,
            }
          : {
              modelNumber,
              phoneSerial,
              imei,
              imei2,
              rentedOut,
              rentedAt,
              assignedUser,
              notes,
            };
      const url =
        mode === "create"
          ? "/api/phones"
          : `/api/phones/${encodeURIComponent(initial!.internal)}`;
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data: { error?: string; message?: string; devMessage?: string } | null = null;
      try { data = await res.json(); } catch { /* fall through */ }
      if (!res.ok) {
        throw new Error(
          data?.devMessage || data?.message || data?.error || `Request failed (${res.status})`,
        );
      }
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">
            {mode === "create" ? "Add phone" : `Edit ${initial?.internal}`}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-1">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Internal (VPM code)
            </label>
            <input
              value={internal}
              onChange={(e) => setInternal(e.target.value)}
              disabled={mode === "edit"} // primary key — immutable post-create
              placeholder="VPM0157"
              maxLength={40}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50 disabled:text-slate-500"
            />
          </div>
          <div className="sm:col-span-1">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Model Number
            </label>
            <input
              value={modelNumber}
              onChange={(e) => setModelNumber(e.target.value)}
              placeholder="MGK43LL/A"
              maxLength={60}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Phone serial number
            </label>
            <input
              value={phoneSerial}
              onChange={(e) => setPhoneSerial(e.target.value)}
              placeholder="HH3HJ0310D83"
              maxLength={60}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="sm:col-span-1">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              IMEI
            </label>
            <input
              value={imei}
              onChange={(e) => setImei(e.target.value)}
              placeholder="35 495773 693796 5"
              maxLength={60}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="sm:col-span-1">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              IMEI 2
            </label>
            <input
              value={imei2}
              onChange={(e) => setImei2(e.target.value)}
              placeholder="35 495773 682990 7"
              maxLength={60}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="sm:col-span-1">
            <label className="inline-flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={rentedOut}
                onChange={(e) => setRentedOut(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              Rented Out
            </label>
          </div>
          <div className="sm:col-span-1">
            <label
              htmlFor="vss-phone-rented-at"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Rented Out date
            </label>
            <input
              id="vss-phone-rented-at"
              type="date"
              value={rentedAt}
              onChange={(e) => setRentedAt(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Assigned User (optional)
            </label>
            <input
              value={assignedUser}
              onChange={(e) => setAssignedUser(e.target.value)}
              placeholder="Name of the person this phone is loaned to"
              maxLength={120}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={
              busy ||
              (mode === "create" && (!internal.trim() || !modelNumber.trim())) ||
              (mode === "edit" && !modelNumber.trim())
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 disabled:hover:bg-brand-600"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : mode === "create" ? (
              <Plus className="h-4 w-4" />
            ) : (
              <Pencil className="h-4 w-4" />
            )}
            {mode === "create" ? "Add phone" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AddPhoneButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
      >
        <Plus className="h-4 w-4" />
        Add phone
      </button>
      {open ? (
        <PhoneDialog
          mode="create"
          initial={null}
          onClose={() => setOpen(false)}
          onSubmitted={() => {
            setOpen(false);
            startTransition(() => router.refresh());
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Bulk-add dialog. Operator pastes a block of CSV / TSV — one phone per
 * line — and we POST it to /api/phones/bulk. Designed for the case where
 * the inventory list lives in a spreadsheet: copy the columns, paste into
 * the textarea, hit "Add N phones".
 *
 * Accepted column order (header row optional, auto-detected):
 *   Internal, Model Number, Phone serial, IMEI, IMEI 2, Rented Out,
 *   Rented Out date, Assigned User, Notes
 * Internal + Model Number are required; the rest are optional. Lines that
 * fail validation are skipped (with a per-row reason) instead of failing
 * the whole batch.
 */
type ParsedBulkRow = {
  lineNo: number; // 1-based, for error reporting
  raw: string;
  ok: boolean;
  /** Reason this row was rejected pre-submit. Undefined when ok. */
  error?: string;
  data?: {
    internal: string;
    modelNumber: string;
    phoneSerial: string;
    imei: string;
    imei2: string;
    rentedOut: boolean;
    rentedAt: string;
    assignedUser: string;
    notes: string;
  };
};

const BULK_HEADERS = [
  "internal",
  "modelnumber",
  "phoneserial",
  "imei",
  "imei2",
  "rentedout",
  "rentedat",
  "assigneduser",
  "notes",
];

function normalizeBulkHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseBulkText(text: string): ParsedBulkRow[] {
  const lines = text.split(/\r?\n/);
  // Auto-detect TSV vs CSV by looking at the first non-empty line.
  const firstLine = lines.find((l) => l.trim().length > 0) ?? "";
  const sep = firstLine.includes("\t") ? "\t" : ",";

  // Look for a header row. Match if every cell on line 1 maps to a known header.
  let columnOrder: (keyof NonNullable<ParsedBulkRow["data"]> | null)[] = [
    "internal",
    "modelNumber",
    "phoneSerial",
    "imei",
    "imei2",
    "rentedOut",
    "rentedAt",
    "assignedUser",
    "notes",
  ];
  let dataStartIndex = 0;
  if (firstLine) {
    const firstCells = firstLine.split(sep).map((c) => normalizeBulkHeader(c));
    if (firstCells.every((c) => BULK_HEADERS.includes(c))) {
      // Operator pasted with a header row — remap columns to match.
      const headerToKey: Record<
        string,
        keyof NonNullable<ParsedBulkRow["data"]>
      > = {
        internal: "internal",
        modelnumber: "modelNumber",
        phoneserial: "phoneSerial",
        imei: "imei",
        imei2: "imei2",
        rentedout: "rentedOut",
        rentedat: "rentedAt",
        assigneduser: "assignedUser",
        notes: "notes",
      };
      columnOrder = firstCells.map((c) => headerToKey[c] ?? null);
      dataStartIndex = lines.indexOf(firstLine) + 1;
    }
  }

  const out: ParsedBulkRow[] = [];
  for (let i = dataStartIndex; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    if (rawLine.trim().length === 0) continue;
    const cells = rawLine.split(sep).map((c) => c.trim());
    const row: NonNullable<ParsedBulkRow["data"]> = {
      internal: "",
      modelNumber: "",
      phoneSerial: "",
      imei: "",
      imei2: "",
      rentedOut: false,
      rentedAt: "",
      assignedUser: "",
      notes: "",
    };
    for (let c = 0; c < cells.length; c++) {
      const key = columnOrder[c];
      if (!key) continue;
      const val = cells[c] ?? "";
      if (key === "rentedOut") {
        // Accept "true", "yes", "y", "1" as true; everything else false.
        row.rentedOut = /^(true|yes|y|1)$/i.test(val);
      } else {
        row[key] = val;
      }
    }
    if (!row.internal) {
      out.push({
        lineNo: i + 1,
        raw: rawLine,
        ok: false,
        error: "missing Internal (VPM code)",
      });
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(row.internal)) {
      out.push({
        lineNo: i + 1,
        raw: rawLine,
        ok: false,
        error: `Internal "${row.internal}" has invalid characters`,
      });
      continue;
    }
    if (!row.modelNumber) {
      out.push({
        lineNo: i + 1,
        raw: rawLine,
        ok: false,
        error: "missing Model Number",
      });
      continue;
    }
    out.push({ lineNo: i + 1, raw: rawLine, ok: true, data: row });
  }
  return out;
}

function BulkAddDialog({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    created: string[];
    skipped: { internal: string; reason: string }[];
    failed: { internal: string; error: string }[];
  } | null>(null);

  const parsed = useMemo(() => parseBulkText(text), [text]);
  const validRows = parsed.filter((r) => r.ok);
  const invalidRows = parsed.filter((r) => !r.ok);

  async function submit() {
    if (validRows.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/phones/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: validRows.map((r) => r.data) }),
      });
      const data = await res
        .json()
        .catch(() => null as null | Record<string, unknown>);
      if (!res.ok) {
        throw new Error(
          (data?.error as string | undefined) ?? `Request failed (${res.status})`,
        );
      }
      const created = (data?.created as string[] | undefined) ?? [];
      const skipped =
        (data?.skipped as { internal: string; reason: string }[] | undefined) ??
        [];
      const failed =
        (data?.failed as { internal: string; error: string }[] | undefined) ??
        [];
      setResult({ created, skipped, failed });
      // Tell the page to refresh data, but keep the dialog open so the
      // operator can see the per-row outcome.
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">
            Bulk add phones
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-1 text-xs text-slate-500">
          Paste rows from a spreadsheet (tab- or comma-separated). One phone
          per line. Required columns:{" "}
          <span className="font-medium text-slate-700">Internal</span> and{" "}
          <span className="font-medium text-slate-700">Model Number</span>.
          Optional columns (in order):{" "}
          <span className="font-mono text-[11px] text-slate-700">
            Phone serial, IMEI, IMEI 2, Rented Out, Rented Out date,
            Assigned User, Notes
          </span>
          . A header row is auto-detected.
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={
            "VPM0200\tMGK43LL/A\tHH3HJ0310D83\t35 495773 693796 5\n" +
            "VPM0201\tMGK43LL/A\n" +
            "VPM0202,MGK43LL/A,G6TDN58W0D83"
          }
          spellCheck={false}
          className="mt-3 w-full flex-shrink-0 rounded-md border border-slate-200 bg-white px-2 py-2 font-mono text-xs text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />

        {/* Parse preview so the operator can see exactly which rows will go
            through before hitting submit. Updates live as they edit. */}
        {text.trim().length > 0 ? (
          <div className="mt-3 flex-1 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
            <div className="mb-2 text-slate-600">
              <span className="font-medium text-slate-900">
                {validRows.length}
              </span>{" "}
              valid · {invalidRows.length > 0 ? (
                <span className="font-medium text-rose-700">
                  {invalidRows.length} skipped (will not be sent)
                </span>
              ) : (
                <span className="text-slate-500">0 skipped</span>
              )}
            </div>
            {validRows.length > 0 ? (
              <table className="min-w-full text-left text-xs">
                <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-1 py-0.5">#</th>
                    <th className="px-1 py-0.5">Internal</th>
                    <th className="px-1 py-0.5">Model</th>
                    <th className="px-1 py-0.5">Serial</th>
                    <th className="px-1 py-0.5">Rented</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {validRows.slice(0, 50).map((r, i) => (
                    <tr key={r.lineNo} className="border-t border-slate-200/60">
                      <td className="px-1 py-0.5 text-slate-400">{i + 1}</td>
                      <td className="px-1 py-0.5 text-slate-900">
                        {r.data!.internal}
                      </td>
                      <td className="px-1 py-0.5 text-slate-700">
                        {r.data!.modelNumber}
                      </td>
                      <td className="px-1 py-0.5 text-slate-700">
                        {r.data!.phoneSerial || "-"}
                      </td>
                      <td className="px-1 py-0.5 text-slate-700">
                        {r.data!.rentedOut ? "yes" : "no"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {validRows.length > 50 ? (
              <div className="mt-1 text-slate-400">
                … and {validRows.length - 50} more
              </div>
            ) : null}
            {invalidRows.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-rose-700">
                {invalidRows.slice(0, 10).map((r) => (
                  <li key={r.lineNo}>
                    Line {r.lineNo}: {r.error}
                  </li>
                ))}
                {invalidRows.length > 10 ? (
                  <li className="text-rose-400">
                    … and {invalidRows.length - 10} more
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : null}

        {result ? (
          <div className="mt-3 rounded-md border border-slate-200 bg-white p-3 text-xs">
            <div className="font-medium text-slate-900">Result</div>
            <ul className="mt-1 space-y-0.5">
              <li className="text-emerald-700">
                ✓ Added {result.created.length} new phone
                {result.created.length === 1 ? "" : "s"}
                {result.created.length > 0 ? (
                  <span className="ml-1 font-mono text-emerald-600">
                    ({result.created.slice(0, 10).join(", ")}
                    {result.created.length > 10
                      ? `, +${result.created.length - 10} more`
                      : ""}
                    )
                  </span>
                ) : null}
              </li>
              {result.skipped.length > 0 ? (
                <li className="text-amber-700">
                  ⤴ Skipped {result.skipped.length}{" "}
                  {result.skipped.length === 1 ? "row" : "rows"}{" "}
                  <span className="text-amber-600">
                    (
                    {result.skipped
                      .slice(0, 5)
                      .map((s) => `${s.internal}: ${s.reason}`)
                      .join("; ")}
                    {result.skipped.length > 5
                      ? `; +${result.skipped.length - 5} more`
                      : ""}
                    )
                  </span>
                </li>
              ) : null}
              {result.failed.length > 0 ? (
                <li className="text-rose-700">
                  ✗ Failed {result.failed.length}{" "}
                  {result.failed.length === 1 ? "row" : "rows"}
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

        {error ? (
          <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {result ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || validRows.length === 0 || result !== null}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 disabled:hover:bg-brand-600"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ListPlus className="h-4 w-4" />
            )}
            {validRows.length > 0
              ? `Add ${validRows.length} phone${validRows.length === 1 ? "" : "s"}`
              : "Add phones"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BulkAddPhonesButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
      >
        <ListPlus className="h-4 w-4" />
        Bulk add
      </button>
      {open ? (
        <BulkAddDialog
          onClose={() => setOpen(false)}
          onSubmitted={() => {
            // Refresh data but keep dialog open so the operator can see the
            // per-row result. They close it manually.
            startTransition(() => router.refresh());
          }}
        />
      ) : null}
    </>
  );
}

export function EditPhoneButton({ phone }: { phone: PhoneRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        <Pencil className="h-3 w-3" />
        Edit
      </button>
      {open ? (
        <PhoneDialog
          mode="edit"
          initial={phone}
          onClose={() => setOpen(false)}
          onSubmitted={() => {
            setOpen(false);
            startTransition(() => router.refresh());
          }}
        />
      ) : null}
    </>
  );
}
