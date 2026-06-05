"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  CalendarRange,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Pencil,
  Search,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import { FormattedDate } from "./FormattedDate";
import { formatDurationSec, formatDurationVerbose } from "@/lib/duration";
import type { SubmissionStatus } from "@vss/db";

export type Row = {
  id: string;
  responseId: string;
  submitterEmail: string;
  submitterName: string;
  category: string;
  status: SubmissionStatus;
  createdAt: string;
  fileCount: number;
  /** Per-submission total video duration in seconds, with same-video
   *  duplicates inside the submission deduped. Null when no file in the
   *  submission has a measured duration. */
  durationSec: number | null;
  /** Person in Charge — typed by an admin via the approve/reject dialog or
   *  the standalone "Edit PIC" button. Null until someone fills it in. */
  personInCharge: string | null;
  /** Phone number supplied by the submitter on the Google Form (the
   *  "Phone Provided" question). Null when the form didn't include it. */
  phoneProvided: string | null;
  /** Free-text reason typed by the admin when rejecting. Null for
   *  not-yet-decided or approved submissions. */
  rejectReason: string | null;
  /** The most-recent Drive file attached to this submission. Used to
   *  render the Phone Provided cell as a clickable link to that file in
   *  Drive (operator workflow: see the submission row → click straight
   *  through to the video). Null when no files have been ingested yet. */
  latestFile: { driveFileId: string; fileName: string } | null;
  /** Original Drive parent-folder name for ingested-from-Drive
   *  submissions. Distinct from `category` (user-editable) — this one is
   *  the immutable "where did the video come from" pointer used as the
   *  Phone Provided cell's link label. Null for form-submitted rows. */
  driveFolderName: string | null;
  /** True when at least one of the submission's files has a matching
   *  "<stem> (clipped).mp4" in the local clips/ folder — i.e. the
   *  clipping pipeline has already processed it. Computed server-side
   *  in /admin/page.tsx by cross-matching against listClips(). */
  isClipped: boolean;
  /** Top-level shared-Drive folder this row's video lives under
   *  (e.g. "VNM", "Hotel 77"). Computed server-side by walking each
   *  submission's driveFolderName up the SA's folder graph. Null when
   *  the row is a FORM submission or the walk couldn't resolve a top
   *  (those bucket as "Other" in the UI). */
  main: string | null;
};

const STATUSES: (SubmissionStatus | "ALL")[] = [
  "ALL",
  "PENDING",
  "SCORING",
  "SCORED",
  "APPROVED",
  "REJECTED",
  "FAILED",
];

type SearchField =
  | "any"
  | "submitter"
  | "category"
  | "submissionId"
  | "pic"
  | "phoneProvided"
  | "main";

/**
 * Parse a `<input type="date">` value (always `YYYY-MM-DD`) as **local-time**
 * midnight. The native `new Date("2026-05-13")` constructor parses that
 * shape as UTC, which silently shifts the day for anyone east of GMT —
 * picking "today" in Singapore would otherwise filter to "yesterday in UTC".
 */
function parseLocalDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function SubmissionsTable({
  rows,
  categoryHistory = [],
  knownMains = [],
  initialSearchQuery = "",
  readOnly = false,
}: {
  rows: Row[];
  /** Recently-used categories (most-recent first, deduped) — rendered as
   *  clickable chips in the Edit Category dialog for one-tap autofill.
   *  Defaults to empty so the prop stays optional for back-compat. */
  categoryHistory?: string[];
  /** Sorted list of distinct top-level Drive folders that have at least
   *  one submission (plus any walked-but-empty mains the SA can see).
   *  Drives the Main filter chip row. Optional — when empty we hide the
   *  chips, the column header still renders but every cell shows "—". */
  knownMains?: string[];
  /** Pre-seed the search box from the URL so deep-links like
   *  `/admin?phoneProvided=VPM0166` land already filtered. Combined
   *  with the default "Any column" search field, this matches
   *  driveFolderName / phoneProvided / fileName etc. all at once. */
  initialSearchQuery?: string;
  /** Guest mode toggle. When true:
   *   - bulk-action toolbar is not rendered
   *   - per-row select checkboxes (incl. the header "select all") are
   *     not rendered
   *   - approve / reject / edit-category / edit-PIC buttons aren't
   *     rendered
   *   - the Clipped / Unclipped filter chip row is not rendered (the
   *     guest already only sees unclipped submissions, so the chip is
   *     either misleading or no-op)
   *   - search, status filter, main filter, and date filter ALL still
   *     work — the guest can find rows; they just can't change them.
   *  Defaults to false so existing admin call-sites keep working. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [filter, setFilter] = useState<SubmissionStatus | "ALL">("ALL");
  // Separate filter dimension — combines with `filter` above.
  // "ALL" = ignore, "CLIPPED" = only rows whose isClipped is true,
  // "UNCLIPPED" = only rows whose isClipped is false.
  const [clipFilter, setClipFilter] = useState<
    "ALL" | "CLIPPED" | "UNCLIPPED"
  >("ALL");
  // Third filter dimension: top-level Drive folder. "ALL" = no filter,
  // any other string = match only rows whose `main` equals it. "Other"
  // catches rows with null main (form submissions, unresolvable mains).
  const [mainFilter, setMainFilter] = useState<string>("ALL");
  // Custom-dropdown open state for the Main filter "select". We do NOT
  // use a native <select> because Safari's OS-level menu would freeze
  // open whenever another chip click (e.g. Unclipped) triggered a
  // parent re-render — the OS menu detaches from the React DOM node
  // and stops responding. A button + DOM-rendered <ul> menu is fully
  // under React's control and immune to that bug.
  const [mainMenuOpen, setMainMenuOpen] = useState(false);
  const mainMenuRef = useRef<HTMLDivElement>(null);

  // Set of main section labels (e.g. "Hotel 77", "Other") the user has
  // EXPANDED. Default is collapsed — empty set means every section is
  // tucked into its header. Hydrated from localStorage after mount so
  // the choice persists across page reloads. We store the *expanded*
  // set (not collapsed) because the natural default is "everything
  // collapsed", so an empty value is the right starting point.
  const COLLAPSE_KEY = "vss:submissions:expandedMains:v1";
  const [expandedMains, setExpandedMains] = useState<Set<string>>(
    () => new Set(),
  );
  // Tracks whether we've finished hydrating from localStorage. Prevents
  // the save-effect from racing the load-effect and wiping the user's
  // saved expansion on first paint.
  const hasHydratedExpanded = useRef(false);
  useEffect(() => {
    if (hasHydratedExpanded.current) return;
    hasHydratedExpanded.current = true;
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setExpandedMains(
            new Set(parsed.filter((x): x is string => typeof x === "string")),
          );
        }
      }
    } catch {
      // Bad JSON / quota error / private mode — fall back to default
      // (everything collapsed). Don't crash the dashboard.
    }
  }, []);
  useEffect(() => {
    if (!hasHydratedExpanded.current) return;
    try {
      localStorage.setItem(
        COLLAPSE_KEY,
        JSON.stringify(Array.from(expandedMains)),
      );
    } catch {
      // Quota / private mode — silent no-op.
    }
  }, [expandedMains]);

  const toggleMainExpanded = useCallback((label: string) => {
    setExpandedMains((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);
  // Default to "any" so a fresh user can type a string they see on
  // screen (a project name, file name, submitter, etc.) and get hits
  // without first picking the "right" search field. Field-specific
  // options remain for power users who want exact-field matching.
  const [searchField, setSearchField] = useState<SearchField>("any");
  // Seeded from initialSearchQuery (the URL `?phoneProvided=…` deep-link).
  // After mount the input is fully user-controlled — they can clear it
  // or change the field without surprise reseeds.
  const [searchQuery, setSearchQuery] = useState<string>(initialSearchQuery);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  // Multi-select bulk-action state. Keyed by submission id (cuid). The
  // selection persists across filter changes — hiding a row by clicking
  // a status chip shouldn't drop it from the selection, but the
  // "select all" checkbox and counter reflect only what's visible.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [bulkPicOpen, setBulkPicOpen] = useState(false);
  const [bulkPicDraft, setBulkPicDraft] = useState<string>("");
  const [bulkCategoryOpen, setBulkCategoryOpen] = useState(false);
  const [bulkCategoryDraft, setBulkCategoryDraft] = useState<string>("");
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Everything *except* the status chip — date range + text search. Used
  // both as the base for the visible `filtered` list (with the status chip
  // applied on top) and as the denominator for the approved/rejected rate
  // cards (where applying the chip would make the rate trivially 100% or
  // 0%, which is useless).
  const filteredIgnoringStatusChip = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    // Inclusive-from, inclusive-to. "From 5/13" includes the whole of 5/13,
    // and "To 5/13" includes the whole of 5/13 — we model "to" as exclusive
    // start-of-next-day for cheap range checks.
    const fromTs = parseLocalDay(dateFrom)?.getTime() ?? null;
    const toDay = parseLocalDay(dateTo);
    const toExclusiveTs = toDay ? toDay.getTime() + ONE_DAY_MS : null;

    return rows.filter((r) => {
      // 1. Date-range filter. Both ends optional and independent.
      if (fromTs != null || toExclusiveTs != null) {
        const ts = new Date(r.createdAt).getTime();
        if (fromTs != null && ts < fromTs) return false;
        if (toExclusiveTs != null && ts >= toExclusiveTs) return false;
      }

      // 2. Text search. When search box is empty, match everything.
      if (q.length === 0) return true;
      if (searchField === "any") {
        // "Any column" — union of every value that's *visible* anywhere
        // in the row (desktop columns + mobile card). This is the new
        // default because the field-specific options surprise new users:
        // e.g. "Category" searches the user-typed Category field only,
        // but the Phone Provided column shows driveFolderName as a
        // fallback, so typing "VPM0166" with Category mode returns 0
        // rows even though VPM0166 is visibly on every Hotel 77 row.
        const haystacks = [
          r.submitterName,
          r.submitterEmail,
          r.category,
          r.id,
          r.personInCharge ?? "",
          r.phoneProvided ?? "",
          r.driveFolderName ?? "",
          r.main ?? "",
          r.latestFile?.fileName ?? "",
          r.rejectReason ?? "",
        ];
        return haystacks.some((h) => h.toLowerCase().includes(q));
      }
      if (searchField === "main") {
        // Match the top-level Drive folder (e.g. "Hotel 77") and the
        // immediate-parent sub-folder (e.g. "VPM0166"). Both are
        // visible in the row — main is its own column, sub-folder
        // shows up in Phone Provided as a link label.
        return (
          (r.main ?? "").toLowerCase().includes(q) ||
          (r.driveFolderName ?? "").toLowerCase().includes(q)
        );
      }
      if (searchField === "submitter") {
        // Match against either name OR email — both are visibly part of the
        // "submitter" cell, so users will type whichever they remember.
        return (
          r.submitterName.toLowerCase().includes(q) ||
          r.submitterEmail.toLowerCase().includes(q)
        );
      }
      if (searchField === "submissionId") {
        // Submission IDs are cuids (24 chars); partial match is useful so
        // operators can paste just the tail they remember from the sheet.
        return r.id.toLowerCase().includes(q);
      }
      if (searchField === "pic") {
        // Rows with no PIC recorded yet shouldn't accidentally match the
        // empty string — `q.length === 0` early-returned above, so we only
        // get here with a real query. Treat missing PIC as no-match.
        return (r.personInCharge ?? "").toLowerCase().includes(q);
      }
      if (searchField === "phoneProvided") {
        // The visible cell value isn't just r.phoneProvided — when that's
        // null (every Drive-ingested submission) the cell falls back to
        // driveFolderName, then category, then the latest file's name
        // (see PhoneProvidedCell below). Search the union so that what
        // the operator types matches what they actually SEE in the
        // column. Otherwise typing "VPM..." or any folder name returns
        // zero rows even though they're visibly there.
        const haystacks = [
          r.phoneProvided ?? "",
          r.driveFolderName ?? "",
          r.category ?? "",
          r.latestFile?.fileName ?? "",
        ];
        return haystacks.some((h) => h.toLowerCase().includes(q));
      }
      return r.category.toLowerCase().includes(q);
    });
  }, [rows, searchField, searchQuery, dateFrom, dateTo]);

  const filtered = useMemo(() => {
    let out = filteredIgnoringStatusChip;
    if (filter !== "ALL") {
      out = out.filter((r) => r.status === filter);
    }
    if (clipFilter === "CLIPPED") {
      out = out.filter((r) => r.isClipped);
    } else if (clipFilter === "UNCLIPPED") {
      out = out.filter((r) => !r.isClipped);
    }
    if (mainFilter !== "ALL") {
      // "Other" chip = no resolved main. Every other chip = exact-match.
      out = out.filter((r) =>
        mainFilter === "Other"
          ? r.main == null
          : r.main === mainFilter,
      );
    }
    return out;
  }, [filteredIgnoringStatusChip, filter, clipFilter, mainFilter]);

  // Group the filtered rows by main, in chip order (alphabetical), with
  // "Other" appended last. Only used when no main filter is active —
  // when one specific main is selected the section headers would be
  // redundant. Rows within a group keep their original (createdAt desc)
  // order to match the existing list semantics.
  const groupedByMain = useMemo(() => {
    type Group = { label: string; rows: Row[] };
    if (mainFilter !== "ALL") {
      // Single bucket — but we still wrap in the same shape so the
      // rendering code stays uniform.
      return [
        {
          label: mainFilter === "Other" ? "Other" : mainFilter,
          rows: filtered,
        },
      ] satisfies Group[];
    }
    const byMain = new Map<string, Row[]>();
    for (const r of filtered) {
      const key = r.main ?? "Other";
      if (!byMain.has(key)) byMain.set(key, []);
      byMain.get(key)!.push(r);
    }
    const sortedKeys = Array.from(byMain.keys()).sort((a, b) => {
      // "Other" always last so the resolved mains (real project folders)
      // surface first.
      if (a === "Other") return 1;
      if (b === "Other") return -1;
      return a.localeCompare(b);
    });
    return sortedKeys.map((k) => ({
      label: k,
      rows: byMain.get(k)!,
    })) satisfies Group[];
  }, [filtered, mainFilter]);

  // Precomputed option list for the Main filter <select>. Stable across
  // re-renders driven by other filter chips (status/clip/search) because
  // it depends only on `knownMains` (a prop) and `hasNullMainRows` (a
  // boolean derived from props).
  //
  // Why this exists: Safari's native <select> menu can get stuck "open"
  // when the option list mutates mid-interaction — e.g. clicking the
  // Unclipped chip triggers a SubmissionsTable re-render, React
  // re-evaluates a conditional `{cond ? <option/> : null}` inside the
  // select, and Safari's already-open OS menu detaches from the DOM
  // node. Stable options + no inline conditional children = no detach.
  const hasNullMainRows = useMemo(
    () => rows.some((r) => r.main == null),
    [rows],
  );
  const mainSelectOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [
      { value: "ALL", label: "All mains" },
    ];
    for (const m of knownMains) opts.push({ value: m, label: m });
    if (hasNullMainRows) opts.push({ value: "Other", label: "Other" });
    return opts;
  }, [knownMains, hasNullMainRows]);

  // Approved / rejected rate over the non-status-chip-filtered population.
  // Stays informative even when the operator clicks the APPROVED or
  // REJECTED chip (otherwise approved% would be a trivial 100% / 0%).
  const { approvedCount, rejectedCount, rateTotalCount } = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    for (const r of filteredIgnoringStatusChip) {
      if (r.status === "APPROVED") approved += 1;
      else if (r.status === "REJECTED") rejected += 1;
    }
    return {
      approvedCount: approved,
      rejectedCount: rejected,
      rateTotalCount: filteredIgnoringStatusChip.length,
    };
  }, [filteredIgnoringStatusChip]);
  const approvedPct =
    rateTotalCount > 0 ? (approvedCount / rateTotalCount) * 100 : 0;
  const rejectedPct =
    rateTotalCount > 0 ? (rejectedCount / rateTotalCount) * 100 : 0;

  const hasDateFilter = dateFrom !== "" || dateTo !== "";

  // Selection helpers. "Select all" toggles whatever's currently visible
  // — same UX as the phone inventory page so operators don't have to
  // learn two patterns. Selection persists across filter changes so the
  // operator can refine the filter then expand again without losing picks.
  const filteredIds = useMemo(() => filtered.map((r) => r.id), [filtered]);
  const selectedInFiltered = useMemo(
    () => filteredIds.filter((id) => selected.has(id)),
    [filteredIds, selected],
  );
  const allFilteredSelected =
    filteredIds.length > 0 &&
    selectedInFiltered.length === filteredIds.length;
  const someFilteredSelected =
    selectedInFiltered.length > 0 && !allFilteredSelected;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const id of filteredIds) next.delete(id);
      } else {
        for (const id of filteredIds) next.add(id);
      }
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
  }

  // Banner auto-dismisses after 5s so it doesn't linger across scroll.
  useEffect(() => {
    if (!bulkMessage) return;
    const t = setTimeout(() => setBulkMessage(null), 5000);
    return () => clearTimeout(t);
  }, [bulkMessage]);

  // Close the Main-filter dropdown on (a) click outside its container or
  // (b) Escape key press. Standard dropdown UX. Listeners only attach
  // while the menu is open so they cost nothing in the common case.
  useEffect(() => {
    if (!mainMenuOpen) return;
    function onPointerDown(e: MouseEvent) {
      const node = mainMenuRef.current;
      if (node && !node.contains(e.target as Node)) {
        setMainMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMainMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mainMenuOpen]);

  async function submitBulkPic() {
    setBulkError(null);
    setBulkBusy(true);
    try {
      const ids = Array.from(selected);
      const res = await fetch("/api/submissions/bulk-pic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, personInCharge: bulkPicDraft }),
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
      const notFound = (data?.notFound as number | undefined) ?? 0;
      const trimmed = bulkPicDraft.trim();
      setBulkMessage(
        `Updated PIC on ${updated} submission${
          updated === 1 ? "" : "s"
        }${trimmed ? ` to "${trimmed}"` : " (cleared)"}${
          skipped > 0 ? ` (${skipped} unchanged)` : ""
        }${notFound > 0 ? ` (${notFound} not found)` : ""}.`,
      );
      clearSelection();
      setBulkPicOpen(false);
      setBulkPicDraft("");
      startTransition(() => router.refresh());
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBulkBusy(false);
    }
  }

  async function submitBulkCategory() {
    setBulkError(null);
    setBulkBusy(true);
    try {
      const ids = Array.from(selected);
      const trimmed = bulkCategoryDraft.trim();
      const res = await fetch("/api/submissions/bulk-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, category: trimmed }),
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
      const notFound = (data?.notFound as number | undefined) ?? 0;
      setBulkMessage(
        `Updated category on ${updated} submission${
          updated === 1 ? "" : "s"
        } to "${trimmed}"${
          skipped > 0 ? ` (${skipped} unchanged)` : ""
        }${notFound > 0 ? ` (${notFound} not found)` : ""}.`,
      );
      clearSelection();
      setBulkCategoryOpen(false);
      setBulkCategoryDraft("");
      startTransition(() => router.refresh());
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBulkBusy(false);
    }
  }

  async function submitBulkDelete() {
    setBulkError(null);
    setBulkBusy(true);
    try {
      const ids = Array.from(selected);
      const res = await fetch("/api/submissions/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
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
      const alreadyDeleted =
        (data?.alreadyDeleted as number | undefined) ?? 0;
      setBulkMessage(
        `Deleted ${deleted} submission${deleted === 1 ? "" : "s"}${
          alreadyDeleted > 0 ? ` (${alreadyDeleted} already deleted)` : ""
        }. Recover from Deleted Submissions if needed.`,
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

  // Total video duration restricted to the currently-visible (filtered)
  // submissions. Switching the status chip from ALL → APPROVED → REJECTED
  // etc. recomputes this card in place. Per-submission durations are already
  // deduped server-side by driveFileId, so summing here is correct.
  const { totalDurationSec, measuredCount } = useMemo(() => {
    let total = 0;
    let measured = 0;
    for (const r of filtered) {
      if (r.durationSec != null) {
        total += r.durationSec;
        measured += 1;
      }
    }
    return { totalDurationSec: total, measuredCount: measured };
  }, [filtered]);

  return (
    <div className="space-y-3">
      {/* Date-range filter, placed at the top of the table area so it sits
          in the header strip — visually under the "Deleted Submissions"
          button on the right. Inclusive on both ends; either bound optional.
          ANDed with the status chips and text search below. */}
      <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
          <CalendarRange className="h-3.5 w-3.5" />
          Submitted
        </span>
        <label htmlFor="vss-date-from" className="text-xs text-slate-500">
          From
        </label>
        <input
          id="vss-date-from"
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          // If the user picks a "to" date earlier than this one we still
          // accept it; the filter just yields zero rows and they'll notice.
          max={dateTo || undefined}
          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <label htmlFor="vss-date-to" className="text-xs text-slate-500">
          To
        </label>
        <input
          id="vss-date-to"
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

      {/* Stats row: total duration on the left + approved & rejected rate
          cards on the right. Rates use the date+search filtered population
          (status chip excluded) so picking APPROVED or REJECTED chip
          doesn't collapse one of the percentages to 0% / 100%. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-brand-50 p-2 text-brand-600">
              <Clock className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Total video duration
                {filter !== "ALL" ||
                searchQuery.trim().length > 0 ||
                hasDateFilter ? (
                  <span className="ml-1 font-medium text-slate-600">
                    ({filter}
                    {searchQuery.trim().length > 0
                      ? ` · ${searchField}: "${searchQuery.trim()}"`
                      : ""}
                    {hasDateFilter
                      ? ` · date: ${dateFrom || "…"} → ${dateTo || "…"}`
                      : ""}
                    )
                  </span>
                ) : null}
              </div>
              <div className="text-xl font-semibold text-slate-900">
                {measuredCount > 0
                  ? formatDurationVerbose(totalDurationSec)
                  : "—"}
              </div>
              <div className="text-xs text-slate-500">
                across {measuredCount}{" "}
                {measuredCount === 1 ? "submission" : "submissions"} with
                measured duration
                {filtered.length !== measuredCount ? (
                  <> ({filtered.length - measuredCount} not yet measured)</>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-emerald-100 p-2 text-emerald-700">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-emerald-700">
                Approved rate
              </div>
              <div className="text-xl font-semibold text-emerald-900 tabular-nums">
                {rateTotalCount > 0 ? `${approvedPct.toFixed(1)}%` : "—"}
              </div>
              <div className="text-xs text-emerald-700/80">
                {approvedCount} of {rateTotalCount}{" "}
                {rateTotalCount === 1 ? "submission" : "submissions"}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-rose-100 p-2 text-rose-700">
              <XCircle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-rose-700">
                Rejected rate
              </div>
              <div className="text-xl font-semibold text-rose-900 tabular-nums">
                {rateTotalCount > 0 ? `${rejectedPct.toFixed(1)}%` : "—"}
              </div>
              <div className="text-xs text-rose-700/80">
                {rejectedCount} of {rateTotalCount}{" "}
                {rateTotalCount === 1 ? "submission" : "submissions"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Filter row: status chips on the left, field-search on the right.
          Wraps to a stack on narrow screens. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={
                "rounded-full border px-3 py-1 text-xs font-medium " +
                (filter === s
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
              }
            >
              {s}
            </button>
          ))}
          {/* Vertical divider between the two filter dimensions so
              operators visually understand they STACK (e.g. SCORED +
              UNCLIPPED). Hidden for guests because the clip filter
              itself is hidden below — without the chips the divider
              would just be a dangling line. */}
          {!readOnly ? (
            <span
              className="mx-1 h-5 w-px bg-slate-300"
              aria-hidden="true"
            />
          ) : null}
          {/* Clipped / Unclipped chip row. Guests never see clipped
              submissions (server-side filter on /admin), so the chip
              would either be misleading ("show clipped" yields zero
              results) or no-op ("show unclipped" matches everything
              they can see anyway). Hide the whole thing. */}
          {!readOnly ? (
            <>
              {(
                [
                  ["ALL", "All"],
                  ["CLIPPED", "Clipped"],
                  ["UNCLIPPED", "Unclipped"],
                ] as const
              ).map(([opt, label]) => (
                <button
                  key={`clip-${opt}`}
                  type="button"
                  onClick={() => setClipFilter(opt)}
                  title={
                    opt === "CLIPPED"
                      ? "Only show submissions whose video has been clipped by detect_hands.py"
                      : opt === "UNCLIPPED"
                      ? "Only show submissions whose video has NOT been clipped yet"
                      : "Don't filter by clip status"
                  }
                  className={
                    "rounded-full border px-3 py-1 text-xs font-medium " +
                    (clipFilter === opt
                      ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
                  }
                >
                  {label}
                </button>
              ))}
            </>
          ) : null}
          {/* Third filter dimension: top-level Drive folder. Only render
              when we actually know any mains AND the viewer is an admin —
              guests are scoped to a single main already (server-side
              filter on /admin), so the chip row would either show one
              redundant chip ("their main") or be misleading. Admin view
              unchanged. */}
          {!readOnly && knownMains.length > 0 ? (
            <>
              <span
                className="mx-1 h-5 w-px bg-slate-300"
                aria-hidden="true"
              />
              <button
                key="main-ALL"
                type="button"
                onClick={() => setMainFilter("ALL")}
                title="Don't filter by Drive main folder"
                className={
                  "rounded-full border px-3 py-1 text-xs font-medium " +
                  (mainFilter === "ALL"
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
                }
              >
                All mains
              </button>
              {knownMains.map((m) => (
                <button
                  key={`main-${m}`}
                  type="button"
                  onClick={() => setMainFilter(m)}
                  title={`Only show rows whose top-level Drive folder is "${m}"`}
                  className={
                    "rounded-full border px-3 py-1 text-xs font-medium " +
                    (mainFilter === m
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
                  }
                >
                  {m}
                </button>
              ))}
              {/* "Other" only worth showing when at least one visible
                  row has no resolved main — otherwise it'd always be
                  empty and clutter the chip strip. */}
              {rows.some((r) => r.main == null) ? (
                <button
                  key="main-Other"
                  type="button"
                  onClick={() => setMainFilter("Other")}
                  title="Rows whose top-level Drive folder couldn't be resolved (form submissions, brand-new folders)"
                  className={
                    "rounded-full border px-3 py-1 text-xs font-medium " +
                    (mainFilter === "Other"
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
                  }
                >
                  Other
                </button>
              ) : null}
              {/* Compact dropdown that mirrors the chip row. Two-way
                  bound to the same `mainFilter` state — picking from
                  the dropdown updates the chips and vice versa. Useful
                  once you have 5+ mains (chips start wrapping); chips
                  stay for fast one-click toggling.

                  Implementation: button + DOM <ul> (NOT a native <select>).
                  See the mainMenuOpen state declaration for why — Safari's
                  OS-level menu would freeze whenever another chip
                  triggered a parent re-render. This custom version
                  is fully React-controlled so re-renders can never
                  detach an open menu. */}
              <div ref={mainMenuRef} className="relative ml-1">
                <button
                  type="button"
                  onClick={() => setMainMenuOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={mainMenuOpen}
                  aria-label="Filter by main folder"
                  title="Filter by top-level Drive folder (matches the chips on the left)"
                  className={
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium " +
                    (mainFilter === "ALL"
                      ? "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      : "border-indigo-500 bg-indigo-50 text-indigo-700 hover:bg-indigo-100")
                  }
                >
                  {mainSelectOptions.find((o) => o.value === mainFilter)
                    ?.label ?? "All mains"}
                  <ChevronDown
                    className={
                      "h-3 w-3 transition-transform " +
                      (mainMenuOpen ? "rotate-180" : "")
                    }
                  />
                </button>
                {mainMenuOpen ? (
                  <ul
                    role="listbox"
                    className="absolute left-0 top-full z-30 mt-1 min-w-[140px] overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-xs shadow-lg"
                  >
                    {mainSelectOptions.map((o) => (
                      <li key={`opt-${o.value}`}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={mainFilter === o.value}
                          onClick={() => {
                            setMainFilter(o.value);
                            setMainMenuOpen(false);
                          }}
                          className={
                            "block w-full px-3 py-1.5 text-left hover:bg-slate-50 " +
                            (mainFilter === o.value
                              ? "bg-indigo-50 font-medium text-indigo-700"
                              : "text-slate-700")
                          }
                        >
                          {o.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        <div className="flex items-stretch gap-0 rounded-md border border-slate-200 bg-white text-sm focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500">
          <label htmlFor="vss-search-field" className="sr-only">
            Search field
          </label>
          <select
            id="vss-search-field"
            value={searchField}
            onChange={(e) => setSearchField(e.target.value as SearchField)}
            className="rounded-l-md border-0 border-r border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-none"
          >
            <option value="any">Any column</option>
            <option value="main">Main / Sub-folder</option>
            <option value="submitter">Submitter</option>
            <option value="category">Category</option>
            <option value="submissionId">Submission ID</option>
            <option value="pic">PIC</option>
            <option value="phoneProvided">Phone Provided</option>
          </select>

          <div className="relative flex flex-1 items-center">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
            <label htmlFor="vss-search-query" className="sr-only">
              Search
            </label>
            <input
              id="vss-search-query"
              type="search"
              autoComplete="off"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                searchField === "any"
                  ? "Search any column (name, VPM0166, Hotel 77…)"
                  : searchField === "main"
                    ? "Search main or sub-folder (e.g. Hotel 77, VPM0166)…"
                    : searchField === "submitter"
                      ? "Search name or email…"
                      : searchField === "submissionId"
                        ? "Search submission ID…"
                        : searchField === "pic"
                          ? "Search PIC name…"
                          : searchField === "phoneProvided"
                            ? "Search phone (e.g. VPM0157)…"
                            : "Search category…"
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

      {/* Bulk-action toolbar — appears when ≥1 submission is selected.
          Mirrors the phone inventory page's pattern so operators have one
          UI to learn. Guests never see this: their checkboxes are hidden
          (so `selected` stays empty), and we belt-and-suspenders the
          render with `!readOnly` so a stray cookie-modify can't slip a
          mutation UI past the gate. */}
      {!readOnly && selected.size > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-2 text-sm">
          <div className="flex items-center gap-2 text-brand-900">
            <CheckSquare className="h-4 w-4" />
            <span className="font-medium">
              {selected.size} submission{selected.size === 1 ? "" : "s"}{" "}
              selected
            </span>
            {selectedInFiltered.length !== selected.size ? (
              <span className="text-xs text-brand-700/80">
                ({selectedInFiltered.length} visible ·{" "}
                {selected.size - selectedInFiltered.length} hidden by current
                filter)
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                // Pre-fill with the most common PIC across the selection
                // (or blank if there's no clear winner). Saves typing for
                // the common case "set everyone to the same PIC".
                const counts = new Map<string, number>();
                for (const id of selected) {
                  const row = rows.find((r) => r.id === id);
                  if (row?.personInCharge) {
                    counts.set(
                      row.personInCharge,
                      (counts.get(row.personInCharge) ?? 0) + 1,
                    );
                  }
                }
                let best: { value: string; count: number } | null = null;
                for (const [value, count] of counts) {
                  if (!best || count > best.count) best = { value, count };
                }
                setBulkPicDraft(best ? best.value : "");
                setBulkPicOpen(true);
              }}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit PIC
            </button>
            <button
              type="button"
              onClick={() => {
                // Pre-fill with the most common category across the
                // selection so "set everyone to the same category" is one
                // confirm. Falls back to the first history entry if the
                // selection has no consensus.
                const counts = new Map<string, number>();
                for (const id of selected) {
                  const row = rows.find((r) => r.id === id);
                  if (row?.category) {
                    counts.set(
                      row.category,
                      (counts.get(row.category) ?? 0) + 1,
                    );
                  }
                }
                let best: { value: string; count: number } | null = null;
                for (const [value, count] of counts) {
                  if (!best || count > best.count) best = { value, count };
                }
                setBulkCategoryDraft(
                  best ? best.value : (categoryHistory[0] ?? ""),
                );
                setBulkCategoryOpen(true);
              }}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit Category
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

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
          No submissions match this filter.
        </div>
      ) : (
        <>
          {/* Mobile: stacked cards. Each card is a single tap target — no
              horizontal scrolling required. Visible on screens < md (768px). */}
          <ul className="space-y-2 md:hidden">
            {filtered.map((r) => {
              const isSelected = selected.has(r.id);
              return (
              <li
                key={r.id}
                className={
                  "flex items-start gap-1 rounded-xl border bg-white " +
                  (isSelected
                    ? "border-brand-300 bg-brand-50/40"
                    : "border-slate-200")
                }
              >
                {/* Checkbox sits *outside* the Link so tapping it doesn't
                    navigate to the detail page. Padding matches the
                    Link's so the tap target stays generous. */}
                <label className="flex shrink-0 cursor-pointer items-center self-stretch pl-3 pr-1">
                  <span className="sr-only">
                    {isSelected ? "Deselect" : "Select"} {r.id}
                  </span>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleOne(r.id)}
                    className="h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                </label>
                <Link
                  href={`/admin/submissions/${r.id}`}
                  className="flex flex-1 items-start gap-3 p-4 pl-1 active:bg-slate-50"
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="truncate font-medium text-slate-900">
                        {r.submitterName}
                      </div>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      {r.submitterEmail}
                    </div>
                    <div
                      className="truncate font-mono text-[10px] text-slate-400"
                      title={r.id}
                    >
                      {r.id}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      {/* Surface the top-level Drive main folder so
                          the mobile card matches the desktop "Main"
                          column. Indigo chip styling matches the
                          desktop badge for visual continuity. */}
                      {r.main ? (
                        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                          {r.main}
                        </span>
                      ) : null}
                      <span>
                        Phone Provided:{" "}
                        {/* On mobile we display text only because the
                            whole card is already a Link to the detail
                            page — nesting an <a> inside is invalid HTML
                            and the outer click would win anyway. The
                            file link is one tap away on the detail page.
                            Show the folder name (category) to match the
                            desktop column. */}
                        {r.latestFile ? (
                          (() => {
                            // Same shorten-clip-output-name rule the
                            // desktop PhoneProvidedCell applies — keeps
                            // the mobile card's label consistent with
                            // the table on the same page.
                            const raw = r.driveFolderName?.trim();
                            const short = raw?.includes("_")
                              ? raw.slice(0, raw.indexOf("_"))
                              : raw;
                            const label =
                              short ||
                              r.category?.trim() ||
                              r.latestFile.fileName;
                            const tip =
                              raw && raw !== short
                                ? `${raw} · ${r.latestFile.fileName}`
                                : r.latestFile.fileName;
                            return (
                              <span
                                className="text-slate-700"
                                title={tip}
                              >
                                {label}
                              </span>
                            );
                          })()
                        ) : r.phoneProvided ? (
                          <span className="text-slate-700">
                            {r.phoneProvided}
                          </span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </span>
                      <span>·</span>
                      <span className="text-slate-700">{r.category}</span>
                      <span>·</span>
                      <span>
                        {r.fileCount} {r.fileCount === 1 ? "file" : "files"}
                      </span>
                      <span>·</span>
                      <span>{formatDurationSec(r.durationSec)}</span>
                      <span>·</span>
                      <span>
                        PIC:{" "}
                        {r.personInCharge ? (
                          <span className="text-slate-700">
                            {r.personInCharge}
                          </span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </span>
                      <span>·</span>
                      <FormattedDate iso={r.createdAt} />
                    </div>
                    {r.rejectReason ? (
                      <div
                        className="line-clamp-2 text-xs text-rose-700"
                        title={r.rejectReason}
                      >
                        Reject reason: {r.rejectReason}
                      </div>
                    ) : null}
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-300" />
                </Link>
              </li>
              );
            })}
          </ul>

          {/* Desktop / tablet: table layout. Wrapper allows horizontal scroll
              as a fallback on awkward viewport widths (e.g. landscape phone). */}
          <div className="hidden md:block">
            {/* Tighter table density + always-visible horizontal
                scrollbar. With 12 columns the right-most cells can
                overflow on narrow viewports; the default macOS
                auto-hiding scrollbar made the overflow invisible.
                Forcing a 2-px-tall styled webkit scrollbar (plus
                modern `scrollbar-*` props) keeps the affordance
                visible without eating much vertical space. */}
            <div
              className={
                "overflow-x-auto rounded-xl border border-slate-200 bg-white " +
                "[scrollbar-color:theme(colors.slate.300)_theme(colors.slate.100)] " +
                "[scrollbar-width:thin] " +
                "[&::-webkit-scrollbar]:h-2 " +
                "[&::-webkit-scrollbar-track]:bg-slate-100 " +
                "[&::-webkit-scrollbar-thumb]:rounded-full " +
                "[&::-webkit-scrollbar-thumb]:bg-slate-300 " +
                "hover:[&::-webkit-scrollbar-thumb]:bg-slate-400"
              }
            >
              <table className="min-w-full divide-y divide-slate-200 text-[13px]">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    {/* "Select all" header checkbox. Hidden for guests
                        (read-only — they have no bulk-edit affordances). */}
                    {!readOnly ? (
                      <th className="w-10 px-3 py-2.5">
                        <label className="inline-flex cursor-pointer items-center">
                          <span className="sr-only">
                            {allFilteredSelected
                              ? "Deselect all"
                              : "Select all"}
                          </span>
                          <input
                            type="checkbox"
                            checked={allFilteredSelected}
                            ref={(el) => {
                              if (el) el.indeterminate = someFilteredSelected;
                            }}
                            onChange={toggleAllFiltered}
                            className="h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                          />
                        </label>
                      </th>
                    ) : null}
                    <th className="px-3 py-2">Submitter</th>
                    <th className="px-3 py-2">Main</th>
                    <th className="px-3 py-2">Phone Provided</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Files</th>
                    <th className="px-3 py-2">Duration</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">PIC</th>
                    <th className="px-3 py-2">Reject Reason</th>
                    <th className="px-3 py-2">Submitted</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {groupedByMain.flatMap((group) => {
                    // Only render section headers when grouping is
                    // meaningful (no main-filter active). When the user
                    // has picked a single main chip the header is
                    // redundant — they already know which main they're
                    // looking at, AND we want every row visible (no
                    // collapse) so they can act on the filter result.
                    const showHeader =
                      mainFilter === "ALL" && groupedByMain.length > 1;
                    // Default-collapsed: rows are only rendered when the
                    // user has explicitly expanded the group OR when
                    // we're not showing a header at all (single-main
                    // filter, in which case "collapse" wouldn't make
                    // sense — show everything).
                    //
                    // Override: if ANY other filter is narrowing the
                    // list (search query, status chip, clip chip, date
                    // range), force every group expanded. Otherwise
                    // operators type a query and see "0 results" even
                    // when matches exist — they're just hidden behind
                    // a collapsed section.
                    const filtersActive =
                      searchQuery.trim().length > 0 ||
                      filter !== "ALL" ||
                      clipFilter !== "ALL" ||
                      dateFrom.length > 0 ||
                      dateTo.length > 0;
                    const isExpanded =
                      !showHeader ||
                      filtersActive ||
                      expandedMains.has(group.label);
                    const headerRow = showHeader ? (
                      <tr
                        key={`main-hdr-${group.label}`}
                        className="bg-indigo-50/60 hover:bg-indigo-50"
                      >
                        <td
                          // Guests don't get the checkbox column, so the
                          // header-row cell that spans the whole table
                          // needs one less colSpan (12 → 11) to avoid an
                          // off-by-one that makes the rightmost column
                          // visually overhang.
                          colSpan={readOnly ? 11 : 12}
                          className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-700"
                        >
                          {/* Whole cell is clickable so the user has a
                              fat hit target — the chevron is the
                              visual cue, but anywhere on the indigo
                              row toggles. */}
                          <button
                            type="button"
                            onClick={() => toggleMainExpanded(group.label)}
                            aria-expanded={isExpanded}
                            aria-controls={`main-body-${group.label}`}
                            title={
                              isExpanded
                                ? `Collapse ${group.label}`
                                : `Expand ${group.label}`
                            }
                            className="flex w-full items-center gap-2 text-left"
                          >
                            <ChevronRight
                              className={
                                "h-3 w-3 transition-transform " +
                                (isExpanded ? "rotate-90" : "")
                              }
                            />
                            <span>{group.label}</span>
                            <span className="font-normal text-indigo-500">
                              ({group.rows.length})
                            </span>
                            {!isExpanded ? (
                              <span className="ml-2 text-[10px] font-normal text-indigo-400">
                                click to expand
                              </span>
                            ) : null}
                          </button>
                        </td>
                      </tr>
                    ) : null;
                    // When collapsed, we still emit the header row but
                    // skip every body row in this group — keeps the DOM
                    // small and avoids rendering invisible 80+ rows
                    // worth of <CategoryCell> editors.
                    if (!isExpanded) {
                      return [headerRow];
                    }
                    return [
                      headerRow,
                      ...group.rows.map((r) => {
                        const isSelected = selected.has(r.id);
                        return (
                    <tr
                      key={r.id}
                      className={
                        isSelected
                          ? "bg-brand-50/50 hover:bg-brand-50"
                          : "hover:bg-slate-50"
                      }
                    >
                      {/* Per-row select checkbox. Hidden for guests so
                          they can't initiate a bulk action they couldn't
                          complete anyway. */}
                      {!readOnly ? (
                        <td className="w-10 px-3 py-3">
                          <label className="inline-flex cursor-pointer items-center">
                            <span className="sr-only">
                              {isSelected ? "Deselect" : "Select"} {r.id}
                            </span>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleOne(r.id)}
                              className="h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                            />
                          </label>
                        </td>
                      ) : null}
                      <td className="px-3 py-2">
                        {/* Make the submitter name itself the primary
                            click target into the detail page. The
                            existing "View" link in the rightmost column
                            stays as a backup, but most users will click
                            the name first — and the rightmost column is
                            often clipped on narrow viewports / through
                            the tunnel. */}
                        <Link
                          href={`/admin/submissions/${r.id}`}
                          className="block font-medium text-slate-900 hover:text-brand-600 hover:underline"
                          prefetch={false}
                        >
                          {r.submitterName}
                        </Link>
                        <div className="text-xs text-slate-500">
                          {r.submitterEmail}
                        </div>
                        <div
                          className="font-mono text-[10px] text-slate-400"
                          title={r.id}
                        >
                          {r.id}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {r.main ? (
                          <button
                            type="button"
                            // Clicking the chip in a row activates that
                            // main as the filter — same UX as clicking
                            // the chip in the header strip.
                            onClick={() => setMainFilter(r.main!)}
                            title={`Filter to only ${r.main}`}
                            className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                          >
                            {r.main}
                          </button>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        <PhoneProvidedCell row={r} readOnly={readOnly} />
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        <CategoryCell
                          submissionId={r.id}
                          value={r.category}
                          history={categoryHistory}
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-700">{r.fileCount}</td>
                      <td className="px-3 py-2 text-slate-700 tabular-nums">
                        {formatDurationSec(r.durationSec)}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {r.personInCharge ? (
                          r.personInCharge
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {r.rejectReason ? (
                          <span
                            className="block max-w-[14rem] truncate"
                            title={r.rejectReason}
                          >
                            {r.rejectReason}
                          </span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-500">
                        <FormattedDate iso={r.createdAt} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {/* Promoted from a thin text link to a proper
                            button so it's discoverable at the same
                            visual weight as the other actions in the
                            row. The submitter-name cell is still a
                            link (primary path), and this button is
                            the secondary, always-visible entry point
                            to the detail page — especially useful in
                            collapsed sections / on the rightmost
                            column where a tiny text link easily got
                            missed at narrow widths. */}
                        <Link
                          href={`/admin/submissions/${r.id}`}
                          prefetch={false}
                          className="inline-flex items-center gap-1 rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 hover:border-brand-300 hover:bg-brand-100"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                        );
                      }),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Bulk edit-PIC dialog. The draft pre-fills with the most common
          PIC across the selection (computed in the button's onClick) so
          "set everyone to the same PIC" is a one-confirm action. */}
      {bulkPicOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !bulkBusy) {
              setBulkPicOpen(false);
            }
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Edit PIC for selected submissions
              </h3>
              <button
                type="button"
                onClick={() => setBulkPicOpen(false)}
                disabled={bulkBusy}
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-2 text-sm text-slate-600">
              This will set the Person in Charge on{" "}
              <span className="font-medium text-slate-900">
                {selected.size} submission{selected.size === 1 ? "" : "s"}
              </span>
              . Approval status, notes, and reject reasons are not changed.
              Soft-deleted submissions are skipped automatically.
            </p>

            <div className="mt-4">
              <label
                htmlFor="vss-subs-bulk-pic"
                className="block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Person in Charge
              </label>
              <input
                id="vss-subs-bulk-pic"
                type="text"
                autoComplete="off"
                value={bulkPicDraft}
                maxLength={120}
                onChange={(e) => setBulkPicDraft(e.target.value)}
                placeholder="e.g. Wei Ling"
                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <p className="mt-1 text-xs text-slate-500">
                Leave blank to clear the PIC field on every selected
                submission.
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
                onClick={() => setBulkPicOpen(false)}
                disabled={bulkBusy}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitBulkPic()}
                disabled={bulkBusy || selected.size === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 disabled:hover:bg-brand-600"
              >
                {bulkBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Pencil className="h-4 w-4" />
                )}
                {bulkPicDraft.trim().length > 0
                  ? `Set PIC on ${selected.size}`
                  : `Clear PIC on ${selected.size}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Bulk Edit Category dialog. Same shape as Edit PIC but with a
          history strip of recently-used categories below the input —
          click a chip to autofill. Categories are saved implicitly: any
          value you commit becomes part of next session's history because
          the chips are pulled from the live submissions table. */}
      {bulkCategoryOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !bulkBusy) {
              setBulkCategoryOpen(false);
            }
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Edit Category for selected submissions
              </h3>
              <button
                type="button"
                onClick={() => setBulkCategoryOpen(false)}
                disabled={bulkBusy}
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-2 text-sm text-slate-600">
              This will set the Category on{" "}
              <span className="font-medium text-slate-900">
                {selected.size} submission{selected.size === 1 ? "" : "s"}
              </span>
              . Status, PIC, and reject reason are unchanged.
            </p>

            <div className="mt-4">
              <label
                htmlFor="vss-subs-bulk-category"
                className="block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Category
              </label>
              <input
                id="vss-subs-bulk-category"
                type="text"
                autoComplete="off"
                value={bulkCategoryDraft}
                maxLength={100}
                onChange={(e) => setBulkCategoryDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter on the text field submits, so power users can
                  // stay on the keyboard ⌨ → type → ↩ → done.
                  if (
                    e.key === "Enter" &&
                    bulkCategoryDraft.trim().length > 0 &&
                    !bulkBusy
                  ) {
                    e.preventDefault();
                    void submitBulkCategory();
                  }
                }}
                placeholder='e.g. "Arts", "Office Task", "15 May"'
                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />

              {categoryHistory.length > 0 ? (
                <div className="mt-3">
                  <div className="text-[11px] uppercase tracking-wide text-slate-400">
                    Recently used — click to autofill
                  </div>
                  <div className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                    {categoryHistory.map((c) => {
                      const active = c === bulkCategoryDraft.trim();
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setBulkCategoryDraft(c)}
                          disabled={bulkBusy}
                          className={
                            "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium " +
                            (active
                              ? "border-brand-500 bg-brand-50 text-brand-700"
                              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")
                          }
                          title={c}
                        >
                          {c}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-xs text-slate-400">
                  No previous categories yet — what you type here will show
                  up as a chip next time.
                </p>
              )}
            </div>

            {bulkError ? (
              <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {bulkError}
              </div>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setBulkCategoryOpen(false)}
                disabled={bulkBusy}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitBulkCategory()}
                disabled={
                  bulkBusy ||
                  selected.size === 0 ||
                  bulkCategoryDraft.trim().length === 0
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 disabled:hover:bg-brand-600"
              >
                {bulkBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Pencil className="h-4 w-4" />
                )}
                Set category on {selected.size}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Bulk delete (soft-delete) dialog. Type-to-confirm because this
          one's destructive. Submissions go to Deleted Submissions, where
          they can be restored individually if needed — same as the
          existing single-row delete flow. */}
      {bulkDeleteOpen ? (
        <SubmissionsBulkDeleteDialog
          count={selected.size}
          ids={Array.from(selected)}
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
 * Type-to-confirm dialog for bulk soft-delete. Its own component so the
 * local "type DELETE" input doesn't pollute the main SubmissionsTable
 * state, and so it resets cleanly on every open.
 */
function SubmissionsBulkDeleteDialog({
  count,
  ids,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  count: number;
  ids: string[];
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
            Delete selected submissions?
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
          This will move{" "}
          <span className="font-medium text-slate-900">
            {count} submission{count === 1 ? "" : "s"}
          </span>{" "}
          to the Deleted Submissions list.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          IDs:{" "}
          <span className="font-mono">
            {ids.slice(0, 5).join(", ")}
            {ids.length > 5 ? `, +${ids.length - 5} more` : ""}
          </span>
        </p>
        <p className="mt-2 text-xs text-slate-500">
          You can restore any of them from{" "}
          <span className="font-medium text-slate-700">
            Deleted Submissions
          </span>{" "}
          afterwards. Approve / Reject and notes editing are disabled while
          a submission is in the trash.
        </p>

        <div className="mt-4">
          <label
            htmlFor="vss-subs-bulk-delete-confirm"
            className="block text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            Type <span className="font-mono text-rose-700">DELETE</span> to
            confirm
          </label>
          <input
            id="vss-subs-bulk-delete-confirm"
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
            Delete {count} submission{count === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Phone Provided cell renderer.
 *
 * Display rules:
 *   1. If the row has a Drive file → render the **Drive folder name**
 *      (which the ingester stores as `category` — e.g. "15 May",
 *      "VPM1060", "VPM0159") as a clickable link to the latest file in
 *      that folder. The text shows the *folder* (operator's mental model
 *      = "which loan-phone bucket did this video come from") while the
 *      link target opens the actual video in a new tab. The file name is
 *      kept as a hover tooltip so operators can still tell which take
 *      they're about to open.
 *   2. Else if the form's `phoneProvided` value is set → render that
 *      string (the historical VPM code / phone label from the Google
 *      Form's Phone Provided answer).
 *   3. Else → "-" placeholder.
 */
function PhoneProvidedCell({
  row,
  readOnly = false,
}: {
  row: Row;
  /** Guest mode: render the cell as plain grey text instead of a
   *  clickable link that opens the Drive video. The label + tooltip
   *  computation is unchanged so operators (and future admins viewing
   *  the same data) get the same string — only the wrapping element
   *  flips from `<a>` to `<span>`. */
  readOnly?: boolean;
}) {
  if (row.latestFile) {
    const driveUrl = `https://drive.google.com/file/d/${row.latestFile.driveFileId}/view`;
    // Prefer the dedicated `driveFolderName` (set at ingest, never edited
    // by the operator) — that's the stable "where did the video come
    // from" pointer. Falls back to `category` for any legacy rows that
    // were ingested before the column existed and somehow missed the
    // backfill, and to the file name as a last resort.
    //
    // Display-only cleanup: when the value is a clip-output subfolder
    // (e.g. "VPM0167_23MAY", "VPM0167_24_25MAY") we strip the date
    // suffix and show just the sub-folder name ("VPM0167"). The full
    // unstripped name is still the tooltip + the link target is
    // unchanged — operator just sees a cleaner label that lines up
    // with the Main column's grouping.
    const rawFolderName = row.driveFolderName?.trim();
    const folderShortLabel = rawFolderName?.includes("_")
      ? rawFolderName.slice(0, rawFolderName.indexOf("_"))
      : rawFolderName;
    const label =
      folderShortLabel ||
      row.category?.trim() ||
      row.latestFile.fileName;
    // Tooltip surfaces the unstripped folder name (if any) so the
    // operator can still see the full "VPM0167_23MAY" — and the file
    // name as a secondary hint.
    const tooltip =
      rawFolderName && rawFolderName !== folderShortLabel
        ? `${rawFolderName} · ${row.latestFile.fileName}`
        : row.latestFile.fileName;
    if (readOnly) {
      // Guest mode: same label + tooltip, but no anchor element so
      // there's no Drive video to open. Grey text (`text-slate-400`)
      // signals "this is not interactive" without screaming about it.
      return (
        <span
          title={tooltip}
          className="block max-w-[20rem] truncate text-slate-400"
        >
          {label}
        </span>
      );
    }
    return (
      <a
        href={driveUrl}
        target="_blank"
        rel="noreferrer"
        title={tooltip}
        className="block max-w-[20rem] truncate text-brand-600 hover:underline"
      >
        {label}
      </a>
    );
  }
  if (row.phoneProvided) {
    // Plain-text branch is the same for both roles — there was never
    // a link here. Just colour it grey for guests to match the
    // unclickable look of the link branch above.
    return (
      <span className={readOnly ? "text-slate-400" : undefined}>
        {row.phoneProvided}
      </span>
    );
  }
  return <span className="text-slate-300">-</span>;
}

/**
 * Inline click-to-edit category cell. Drive-ingested submissions start
 * with an empty category (they used to inherit the folder name, but
 * that's now `driveFolderName` instead so operators can manually classify
 * each video). Clicking the cell opens a popover with:
 *   - text input pre-filled with the current value (or empty for blank)
 *   - history chips of recently-used categories — click to autofill
 *   - Enter saves, Esc cancels, ✕ button cancels
 *
 * Uses the per-row /api/submissions/[id]/category endpoint (separate
 * from the bulk one because per-row allows clearing the value).
 */
function CategoryCell({
  submissionId,
  value,
  history,
}: {
  submissionId: string;
  value: string;
  history: string[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset the local draft whenever the parent value flips — happens after
  // a successful save + router.refresh() rebuilds the table.
  useEffect(() => {
    if (!open) setDraft(value);
  }, [value, open]);

  async function save(next: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/submissions/${encodeURIComponent(submissionId)}/category`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: next }),
        },
      );
      const data = await res
        .json()
        .catch(() => null as null | Record<string, unknown>);
      if (!res.ok) {
        throw new Error(
          (data?.error as string | undefined) ?? `Request failed (${res.status})`,
        );
      }
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    // Idle render — looks like a value cell but is clickable. Empty
    // value shows a muted "Add category…" placeholder so blank Drive
    // rows are discoverable as editable rather than looking broken.
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
        title="Click to edit category"
        className={
          "block w-full max-w-[14rem] truncate rounded px-1 py-0.5 text-left text-slate-700 hover:bg-slate-100 " +
          (value.trim().length === 0 ? "text-slate-300 italic" : "")
        }
      >
        {value.trim().length === 0 ? "Add category…" : value}
      </button>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          type="text"
          value={draft}
          maxLength={100}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save(draft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              setDraft(value);
            }
          }}
          placeholder="e.g. Arts, Office Task"
          className="w-44 rounded-md border border-brand-500 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <button
          type="button"
          onClick={() => void save(draft)}
          disabled={busy}
          title="Save (Enter)"
          className="rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setDraft(value);
            setErr(null);
          }}
          disabled={busy}
          title="Cancel (Esc)"
          className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {history.length > 0 ? (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-md border border-slate-200 bg-white p-2 shadow-lg">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Recently used — click to autofill
          </div>
          <div className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-y-auto">
            {history.slice(0, 24).map((c) => {
              const active = c === draft.trim();
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setDraft(c)}
                  disabled={busy}
                  className={
                    "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium " +
                    (active
                      ? "border-brand-500 bg-brand-50 text-brand-700"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")
                  }
                  title={c}
                >
                  {c}
                </button>
              );
            })}
          </div>
          {err ? (
            <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
              {err}
            </div>
          ) : null}
        </div>
      ) : err ? (
        <div className="absolute left-0 top-full z-20 mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
          {err}
        </div>
      ) : null}
    </div>
  );
}
