"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  CalendarClock,
  CalendarRange,
  CheckSquare,
  Loader2,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { FormattedDate } from "@/components/FormattedDate";
import { EditPhoneButton, type PhoneRow } from "./PhoneFormButtons";

export type PhoneTableRow = PhoneRow & {
  submissions: {
    id: string;
    submitterName: string;
    submitterEmail: string;
    category: string;
    status: string;
    createdAt: string;
  }[];
  /** Distinct top-level Drive folder(s) this phone has appeared
   *  under, comma-joined (e.g. "Hotel 77" or "Hotel 77, VNM"). Null
   *  when no matched submission resolves a main. */
  main: string | null;
  /** Count of matched submissions whose file name contains
   *  "(clipped)" — same rule as /admin's Clipped chip. */
  clippedCount: number;
  /** Inverse: matched submissions whose files don't have "(clipped)". */
  unclippedCount: number;
};

type SearchField = "internal" | "phoneSerial";
type RentedFilter = "ALL" | "YES" | "NO";

function parseLocalDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function PhonesTable({ phones }: { phones: PhoneTableRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [searchField, setSearchField] = useState<SearchField>("internal");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [rentedFilter, setRentedFilter] = useState<RentedFilter>("ALL");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  // Multi-select state for the bulk rented-status action. Keyed by
  // `internal` (the VPM code) because it's stable across re-renders and is
  // what the server endpoint expects.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  // When the bulk dialog asks for a "Rented on" date for the toggled-on
  // batch, defaults to today (operator can clear it to leave unset).
  const [bulkRentedAtDraft, setBulkRentedAtDraft] = useState<string>("");
  // null = no confirmation open; the boolean is the target rentedOut value.
  const [pendingBulkAction, setPendingBulkAction] = useState<null | boolean>(
    null,
  );
  // Independent dialog state for the two additional bulk operations.
  // Kept separate from `pendingBulkAction` so each dialog has its own
  // draft state without weird mode-switching bugs (operator opens "edit
  // date", changes their mind, opens "delete" — shouldn't carry over).
  const [bulkEditDateOpen, setBulkEditDateOpen] = useState(false);
  const [bulkEditDateDraft, setBulkEditDateDraft] = useState<string>("");
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    // "From 5/13" includes the whole of 5/13; "To 5/13" includes the whole of
    // 5/13. We model "to" as exclusive start-of-next-day for cheap range
    // checks against the timestamp.
    const fromTs = parseLocalDay(dateFrom)?.getTime() ?? null;
    const toDay = parseLocalDay(dateTo);
    const toExclusiveTs = toDay ? toDay.getTime() + ONE_DAY_MS : null;

    return phones.filter((p) => {
      // 1. Rented-out status chip.
      if (rentedFilter === "YES" && !p.rentedOut) return false;
      if (rentedFilter === "NO" && p.rentedOut) return false;

      // 2. Date-range filter against rentedAt. Phones without a recorded
      //    rental date are excluded only when at least one bound is set —
      //    otherwise "no filter" lets them through.
      if (fromTs != null || toExclusiveTs != null) {
        if (!p.rentedAt) return false;
        const ts = new Date(p.rentedAt).getTime();
        if (fromTs != null && ts < fromTs) return false;
        if (toExclusiveTs != null && ts >= toExclusiveTs) return false;
      }

      // 3. Text search. When empty, match everything.
      if (q.length === 0) return true;
      if (searchField === "internal") {
        return p.internal.toLowerCase().includes(q);
      }
      // phoneSerial
      return (p.phoneSerial ?? "").toLowerCase().includes(q);
    });
  }, [phones, rentedFilter, searchField, searchQuery, dateFrom, dateTo]);

  const hasDateFilter = dateFrom !== "" || dateTo !== "";

  // Selection bookkeeping over the *filtered* set. Hiding a row via the
  // filter shouldn't drop it from the selection (so the operator can
  // refine the filter then expand again without losing their picks), but
  // the "Select all" checkbox and the "X of Y selected" counter reflect
  // what's currently visible. This matches typical mail-app behavior.
  const filteredInternals = useMemo(
    () => filtered.map((p) => p.internal),
    [filtered],
  );
  const selectedInFiltered = useMemo(
    () => filteredInternals.filter((id) => selected.has(id)),
    [filteredInternals, selected],
  );
  const allFilteredSelected =
    filteredInternals.length > 0 &&
    selectedInFiltered.length === filteredInternals.length;
  const someFilteredSelected =
    selectedInFiltered.length > 0 && !allFilteredSelected;

  function toggleOne(internal: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(internal)) next.delete(internal);
      else next.add(internal);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const id of filteredInternals) next.delete(id);
      } else {
        for (const id of filteredInternals) next.add(id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  // Clear the transient banner after a few seconds so it doesn't linger
  // when the operator scrolls back later.
  useEffect(() => {
    if (!bulkMessage) return;
    const t = setTimeout(() => setBulkMessage(null), 5000);
    return () => clearTimeout(t);
  }, [bulkMessage]);

  async function submitBulkStatus(rentedOut: boolean) {
    setBulkError(null);
    setBulkBusy(true);
    try {
      const internals = Array.from(selected);
      const res = await fetch("/api/phones/bulk-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          internals,
          rentedOut,
          // Only send the date when marking *as rented out*. Marking as
          // available implicitly clears the date on the server side.
          rentedAt:
            rentedOut && bulkRentedAtDraft.trim().length > 0
              ? bulkRentedAtDraft
              : undefined,
        }),
      });
      const data = await res
        .json()
        .catch(() => null as null | Record<string, unknown>);
      if (!res.ok) {
        throw new Error(
          (data?.error as string | undefined) ?? `Request failed (${res.status})`,
        );
      }
      const updated = (data?.updated as number | undefined) ?? 0;
      const skipped = (data?.skipped as number | undefined) ?? 0;
      setBulkMessage(
        `Updated ${updated} phone${updated === 1 ? "" : "s"} to ${
          rentedOut ? "rented out" : "available"
        }${skipped > 0 ? ` (${skipped} unchanged)` : ""}.`,
      );
      // Drop the selection — the rows still exist, but the action is
      // done and a fresh table state is about to come back from the
      // server-component refresh.
      clearSelection();
      setPendingBulkAction(null);
      setBulkRentedAtDraft("");
      startTransition(() => router.refresh());
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBulkBusy(false);
    }
  }

  /**
   * Set `rentedAt` for every selected phone, without touching their
   * rented-out flag or assigned user. Empty draft clears the date.
   */
  async function submitBulkDate() {
    setBulkError(null);
    setBulkBusy(true);
    try {
      const internals = Array.from(selected);
      const res = await fetch("/api/phones/bulk-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internals, rentedAt: bulkEditDateDraft }),
      });
      const data = await res
        .json()
        .catch(() => null as null | Record<string, unknown>);
      if (!res.ok) {
        throw new Error(
          (data?.error as string | undefined) ?? `Request failed (${res.status})`,
        );
      }
      const updated = (data?.updated as number | undefined) ?? 0;
      const skipped = (data?.skipped as number | undefined) ?? 0;
      const trimmed = bulkEditDateDraft.trim();
      setBulkMessage(
        `Updated rent-out date on ${updated} phone${
          updated === 1 ? "" : "s"
        }${trimmed ? ` to ${trimmed}` : " (cleared)"}${
          skipped > 0 ? ` (${skipped} unchanged)` : ""
        }.`,
      );
      clearSelection();
      setBulkEditDateOpen(false);
      setBulkEditDateDraft("");
      startTransition(() => router.refresh());
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBulkBusy(false);
    }
  }

  /**
   * Hard-delete every selected phone. Audit log on the server keeps a
   * per-VPM snapshot so a mistaken bulk delete is recoverable.
   */
  async function submitBulkDelete() {
    setBulkError(null);
    setBulkBusy(true);
    try {
      const internals = Array.from(selected);
      const res = await fetch("/api/phones/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internals }),
      });
      const data = await res
        .json()
        .catch(() => null as null | Record<string, unknown>);
      if (!res.ok) {
        throw new Error(
          (data?.error as string | undefined) ?? `Request failed (${res.status})`,
        );
      }
      const deleted = (data?.deleted as number | undefined) ?? 0;
      const notFound = (data?.notFound as number | undefined) ?? 0;
      setBulkMessage(
        `Deleted ${deleted} phone${deleted === 1 ? "" : "s"}${
          notFound > 0 ? ` (${notFound} not found)` : ""
        }.`,
      );
      clearSelection();
      setBulkDeleteOpen(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Top row: date range + status chips + searchable dropdown. Mirrors
          the dashboard's SubmissionsTable so operators don't have to learn
          a second filter UI. */}
      <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
          <CalendarRange className="h-3.5 w-3.5" />
          Rented out date
        </span>
        <label htmlFor="vss-phones-from" className="text-xs text-slate-500">
          From
        </label>
        <input
          id="vss-phones-from"
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          max={dateTo || undefined}
          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <label htmlFor="vss-phones-to" className="text-xs text-slate-500">
          To
        </label>
        <input
          id="vss-phones-to"
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          min={dateFrom || undefined}
          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        {hasDateFilter ? (
          <button
            type="button"
            onClick={() => {
              setDateFrom("");
              setDateTo("");
            }}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <X className="h-3 w-3" />
            Clear dates
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {(["ALL", "YES", "NO"] as RentedFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setRentedFilter(s)}
              className={
                "rounded-full border px-3 py-1 text-xs font-medium " +
                (rentedFilter === s
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
              }
            >
              {s === "ALL"
                ? "All"
                : s === "YES"
                  ? "Rented out"
                  : "Available"}
            </button>
          ))}
        </div>

        <div className="flex items-stretch gap-0 rounded-md border border-slate-200 bg-white text-sm focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500">
          <label htmlFor="vss-phones-search-field" className="sr-only">
            Search field
          </label>
          <select
            id="vss-phones-search-field"
            value={searchField}
            onChange={(e) => setSearchField(e.target.value as SearchField)}
            className="rounded-l-md border-0 border-r border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-none"
          >
            <option value="internal">Internal</option>
            <option value="phoneSerial">Serial Number</option>
          </select>

          <div className="relative flex flex-1 items-center">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
            <label htmlFor="vss-phones-search-query" className="sr-only">
              Search
            </label>
            <input
              id="vss-phones-search-query"
              type="search"
              autoComplete="off"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                searchField === "internal"
                  ? "Search VPM code…"
                  : "Search serial number…"
              }
              className="w-full rounded-r-md border-0 bg-white py-1.5 pl-8 pr-7 text-sm placeholder:text-slate-400 focus:outline-none lg:w-72"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                className="absolute right-1.5 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Bulk-action toolbar. Renders as a brand-coloured strip when ≥1
          phone is selected, so the actions are unmissable but the empty
          state doesn't take up vertical space. Sits between the filter
          row and the table, *above* the counter, so the operator's eye
          tracks the count → toolbar → table in order. */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-2 text-sm">
          <div className="flex items-center gap-2 text-brand-900">
            <CheckSquare className="h-4 w-4" />
            <span className="font-medium">
              {selected.size} phone{selected.size === 1 ? "" : "s"} selected
            </span>
            {selectedInFiltered.length !== selected.size ? (
              <span className="text-xs text-brand-700/80">
                ({selectedInFiltered.length} visible · {" "}
                {selected.size - selectedInFiltered.length} hidden by current
                filter)
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                // Pre-fill today's date so the operator's most common
                // workflow ("mark these phones as just rented out") is one
                // click + confirm.
                const today = new Date();
                const y = today.getFullYear();
                const m = String(today.getMonth() + 1).padStart(2, "0");
                const d = String(today.getDate()).padStart(2, "0");
                setBulkRentedAtDraft(`${y}-${m}-${d}`);
                setPendingBulkAction(true);
              }}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
            >
              Mark as rented out
            </button>
            <button
              type="button"
              onClick={() => setPendingBulkAction(false)}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Mark as available
            </button>
            <button
              type="button"
              onClick={() => {
                // Pre-fill today so the most common case ("retroactively
                // mark all these phones as rented out on X") is one click.
                const today = new Date();
                const y = today.getFullYear();
                const m = String(today.getMonth() + 1).padStart(2, "0");
                const d = String(today.getDate()).padStart(2, "0");
                setBulkEditDateDraft(`${y}-${m}-${d}`);
                setBulkEditDateOpen(true);
              }}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <CalendarClock className="h-3.5 w-3.5" />
              Edit rent-out date
            </button>
            <button
              type="button"
              onClick={() => setBulkDeleteOpen(true)}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-white hover:text-slate-900 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {bulkMessage ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {bulkMessage}
        </div>
      ) : null}
      {bulkError ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {bulkError}
        </div>
      ) : null}

      <div className="text-xs text-slate-500">
        {filtered.length} of {phones.length}{" "}
        {phones.length === 1 ? "phone" : "phones"} match these filters
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
          No phones match these filters.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-10 px-3 py-2.5">
                  <label className="inline-flex cursor-pointer items-center">
                    <span className="sr-only">
                      {allFilteredSelected ? "Deselect all" : "Select all"}
                    </span>
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      // Mixed state when only some visible rows are picked —
                      // standard pattern for select-all checkboxes.
                      ref={(el) => {
                        if (el) el.indeterminate = someFilteredSelected;
                      }}
                      onChange={toggleAllFiltered}
                      className="h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                  </label>
                </th>
                <th className="px-3 py-2.5 text-right">#</th>
                <th className="px-4 py-2.5">Internal</th>
                <th className="px-4 py-2.5">Main</th>
                <th className="px-4 py-2.5">Model Number</th>
                <th className="px-4 py-2.5">Phone serial number</th>
                <th className="px-4 py-2.5">IMEI</th>
                <th className="px-4 py-2.5">IMEI 2</th>
                <th className="px-4 py-2.5">Rented Out</th>
                <th className="px-4 py-2.5">Rented Out date</th>
                <th className="px-4 py-2.5">Assigned User</th>
                <th className="px-4 py-2.5">Submissions using this phone</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((p, i) => {
                const isSelected = selected.has(p.internal);
                return (
                <tr
                  key={p.internal}
                  className={
                    "align-top " +
                    (isSelected
                      ? "bg-brand-50/50 hover:bg-brand-50"
                      : "hover:bg-slate-50")
                  }
                >
                  <td className="w-10 px-3 py-3">
                    <label className="inline-flex cursor-pointer items-center">
                      <span className="sr-only">
                        {isSelected ? "Deselect" : "Select"} {p.internal}
                      </span>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(p.internal)}
                        className="h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                    </label>
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-slate-400 tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {/* Click → jumps to /admin pre-filtered to this
                        phone via the existing Phone Provided search
                        field. Uses ?searchField= + ?q= conventions if
                        we ever wire them up; today the param it accepts
                        is `phoneProvided`, which the Submissions table
                        already reads. */}
                    <Link
                      href={`/admin?phoneProvided=${encodeURIComponent(p.internal)}`}
                      title={`See every submission tagged ${p.internal} on the dashboard`}
                      className="text-slate-900 hover:text-brand-600 hover:underline"
                      prefetch={false}
                    >
                      {p.internal}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {p.main ? (
                      <span
                        className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700"
                        title={p.main}
                      >
                        {p.main}
                      </span>
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{p.modelNumber}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">
                    {p.phoneSerial ?? (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">
                    {p.imei ?? <span className="text-slate-300">-</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">
                    {p.imei2 ?? <span className="text-slate-300">-</span>}
                  </td>
                  <td className="px-4 py-3">
                    {p.rentedOut ? (
                      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                        Yes
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
                        No
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700 tabular-nums">
                    {p.rentedAt ? (
                      // Date-only — the time-of-day on a "rented out
                      // date" was always meaningless, so we drop it to
                      // declutter the table.
                      <FormattedDate iso={p.rentedAt} dateOnly />
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {p.assignedUser ? (
                      p.assignedUser
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {p.submissions.length === 0 ? (
                      <span className="text-slate-300">No submissions yet</span>
                    ) : (
                      <div className="space-y-1.5">
                        {/* Roll-up: total + clipped/unclipped breakdown.
                            Mirrors /admin's Clipped chip semantics. */}
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="font-medium text-slate-700">
                            {p.submissions.length}{" "}
                            {p.submissions.length === 1
                              ? "submission"
                              : "submissions"}
                          </span>
                          {p.clippedCount > 0 ? (
                            <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                              {p.clippedCount} clipped
                            </span>
                          ) : null}
                          {p.unclippedCount > 0 ? (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
                              {p.unclippedCount} unclipped
                            </span>
                          ) : null}
                        </div>
                        <ul className="space-y-1">
                          {p.submissions.slice(0, 5).map((s) => (
                            <li key={s.id} className="text-xs">
                              <Link
                                href={`/admin/submissions/${s.id}`}
                                className="font-medium text-brand-600 hover:underline"
                              >
                                {s.submitterName || s.submitterEmail}
                              </Link>
                              <span className="text-slate-400">
                                {" · "}
                                {s.category}
                                {" · "}
                                {s.status}
                                {" · "}
                                <FormattedDate iso={s.createdAt} />
                              </span>
                            </li>
                          ))}
                          {p.submissions.length > 5 ? (
                            <li className="text-xs text-slate-400">
                              … and {p.submissions.length - 5} more
                            </li>
                          ) : null}
                        </ul>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <EditPhoneButton phone={p} />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Confirmation dialog — pops up after the operator chooses an
          action, so they get to double-check the count and (for "rented
          out") pick a date before committing. Click-outside cancels. */}
      {pendingBulkAction !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !bulkBusy) {
              setPendingBulkAction(null);
            }
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                {pendingBulkAction
                  ? "Mark selected phones as rented out?"
                  : "Mark selected phones as available?"}
              </h3>
              <button
                type="button"
                onClick={() => setPendingBulkAction(null)}
                disabled={bulkBusy}
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-2 text-sm text-slate-600">
              This will update{" "}
              <span className="font-medium text-slate-900">
                {selected.size} phone{selected.size === 1 ? "" : "s"}
              </span>{" "}
              ({Array.from(selected).slice(0, 5).join(", ")}
              {selected.size > 5 ? `, +${selected.size - 5} more` : ""}).
            </p>

            {pendingBulkAction ? (
              <div className="mt-4">
                <label
                  htmlFor="vss-phones-bulk-rentedat"
                  className="block text-xs font-medium uppercase tracking-wide text-slate-500"
                >
                  Rented Out date (optional)
                </label>
                <input
                  id="vss-phones-bulk-rentedat"
                  type="date"
                  value={bulkRentedAtDraft}
                  onChange={(e) => setBulkRentedAtDraft(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Leave blank to keep each phone's existing rental date
                  unchanged.
                </p>
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-500">
                Marking as available will clear each phone's recorded rental
                date and assigned user.
              </p>
            )}

            {bulkError ? (
              <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {bulkError}
              </div>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingBulkAction(null)}
                disabled={bulkBusy}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitBulkStatus(pendingBulkAction)}
                disabled={bulkBusy || selected.size === 0}
                className={
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white shadow-sm disabled:opacity-50 " +
                  (pendingBulkAction
                    ? "bg-emerald-600 hover:bg-emerald-700 disabled:hover:bg-emerald-600"
                    : "bg-slate-700 hover:bg-slate-800 disabled:hover:bg-slate-700")
                }
              >
                {bulkBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : pendingBulkAction ? (
                  <CheckSquare className="h-4 w-4" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
                {pendingBulkAction
                  ? `Mark ${selected.size} as rented out`
                  : `Mark ${selected.size} as available`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Bulk "Edit rent-out date" dialog. Updates rentedAt only — leaves
          rentedOut and assignedUser alone. Empty date clears the field. */}
      {bulkEditDateOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !bulkBusy) {
              setBulkEditDateOpen(false);
            }
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Edit rent-out date for selected phones
              </h3>
              <button
                type="button"
                onClick={() => setBulkEditDateOpen(false)}
                disabled={bulkBusy}
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-2 text-sm text-slate-600">
              Sets the Rented Out date on{" "}
              <span className="font-medium text-slate-900">
                {selected.size} phone{selected.size === 1 ? "" : "s"}
              </span>{" "}
              ({Array.from(selected).slice(0, 5).join(", ")}
              {selected.size > 5 ? `, +${selected.size - 5} more` : ""}).
              The rented-out status and assigned user are left unchanged.
            </p>

            <div className="mt-4">
              <label
                htmlFor="vss-phones-bulk-editdate"
                className="block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Rented Out date
              </label>
              <input
                id="vss-phones-bulk-editdate"
                type="date"
                value={bulkEditDateDraft}
                onChange={(e) => setBulkEditDateDraft(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <p className="mt-1 text-xs text-slate-500">
                Leave blank to clear the recorded date on every selected
                phone.
              </p>
            </div>

            {bulkError ? (
              <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {bulkError}
              </div>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setBulkEditDateOpen(false)}
                disabled={bulkBusy}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitBulkDate()}
                disabled={bulkBusy || selected.size === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 disabled:hover:bg-brand-600"
              >
                {bulkBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CalendarClock className="h-4 w-4" />
                )}
                {bulkEditDateDraft.trim().length > 0
                  ? `Update date on ${selected.size}`
                  : `Clear date on ${selected.size}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Bulk delete dialog — extra-deliberate confirmation because this
          one's destructive. Requires typing "DELETE" exactly to enable the
          submit button (standard pattern for irreversible actions). */}
      {bulkDeleteOpen ? (
        <BulkDeleteDialog
          count={selected.size}
          internals={Array.from(selected)}
          busy={bulkBusy}
          error={bulkError}
          onClose={() => setBulkDeleteOpen(false)}
          onConfirm={() => void submitBulkDelete()}
        />
      ) : null}
    </div>
  );
}

/**
 * Type-to-confirm dialog for bulk delete. Pulled out into its own
 * component so its local "type DELETE to confirm" input doesn't pollute
 * the main PhonesTable state, and so it resets automatically on close.
 */
function BulkDeleteDialog({
  count,
  internals,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  count: number;
  internals: string[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const armed = typed.trim().toUpperCase() === "DELETE";

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-rose-900">
            Delete selected phones?
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

        <p className="mt-2 text-sm text-slate-700">
          This will permanently delete{" "}
          <span className="font-medium text-slate-900">
            {count} phone{count === 1 ? "" : "s"}
          </span>{" "}
          ({internals.slice(0, 5).join(", ")}
          {internals.length > 5 ? `, +${internals.length - 5} more` : ""}).
        </p>
        <p className="mt-2 text-xs text-slate-500">
          A snapshot of each phone is kept in the audit log so the entries
          can be recreated manually if needed. Submissions previously
          recorded against these VPM codes are <em>not</em> affected — the
          form's "Phone Provided" string is stored on each submission
          independently.
        </p>

        <div className="mt-4">
          <label
            htmlFor="vss-phones-bulk-delete-confirm"
            className="block text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            Type <span className="font-mono text-rose-700">DELETE</span> to
            confirm
          </label>
          <input
            id="vss-phones-bulk-delete-confirm"
            type="text"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
          />
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
            onClick={onConfirm}
            disabled={busy || !armed || count === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-rose-700 disabled:opacity-50 disabled:hover:bg-rose-600"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Delete {count} phone{count === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
