"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  CheckCircle2,
  ChevronRight,
  Download,
  FolderUp,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";

// -----------------------------------------------------------------------------
// Types mirroring the JSON shape served by /api/clips and /api/clipping/run.
// -----------------------------------------------------------------------------

type ClipRow = {
  clipId: string;
  fileName: string;
  sizeBytes: number;
  mtime: string;
  durationSeconds: number | null;
  activityLabel: string | null;
  score: number | null;
  driveFileId: string | null;
  uploadedAt: string | null;
  /** Top-level shared-Drive folder this clip belongs to (e.g. "VNM",
   *  "Hotel 77"). Populated by /api/clips via getDriveMains(). Null if
   *  the source video's folder can't be resolved — those clips bucket
   *  under "Other" in the dashboard tree. */
  main: string | null;
};

type IncomingRow = {
  fileName: string;
  sizeBytes: number;
  mtime: string;
};

type DestinationFolder = { id: string | null; name: string };

type ClipsApiResponse = {
  pipelineRoot: string;
  clipsDir?: string;
  incomingDir?: string;
  clips: ClipRow[];
  incoming: IncomingRow[];
  error?: string;
  message?: string;
  destination?: DestinationFolder;
};

type RunState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  log: string[];
  step:
    | "idle"
    | "pull_from_drive"
    | "pull_form_submissions"
    | "detect_hands"
    | "upload_clips_to_drive"
    | "done"
    | "error";
};

type FormSubmission = {
  id: string;
  submitterName: string;
  submitterEmail: string;
  category: string;
  createdAt: string;
  status: string;
  fileName: string | null;
  driveFileId: string | null;
  durationSec: number | null;
};

// -----------------------------------------------------------------------------
// Format helpers
// -----------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(sec: number | null): string {
  if (sec == null) return "—";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// ---- Filename → group/date parser -----------------------------------
//
// Matches names like:
//   VPM0166-23MAY.mp4               -> group=VPM0166, date=23MAY
//   VPM0166-24_25MAY-1 (clipped).mp4 -> group=VPM0166, date=24_25MAY
//   VPM0167-23MAY-3 (clipped).mp4   -> group=VPM0167, date=23MAY
// Anything that doesn't fit (rgb.mp4, c5e3dab720_rgb.mp4) falls into
// the "Other" bucket so it's still visible in the tree.
const GROUP_RE =
  /^([A-Z]+\d+)[-_]([\dA-Z_]+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC))/i;

function parseGroup(fileName: string): { group: string; date: string } {
  // Form submissions sometimes show as "<formId>/<filename>" — peek
  // past the prefix if it doesn't itself look like a VPM group name.
  let core = fileName;
  const slash = fileName.indexOf("/");
  if (slash > 0 && !/^[A-Z]+\d+[-_]/i.test(fileName)) {
    core = fileName.slice(slash + 1);
  }
  const noExt = core.replace(/\.(mp4|mov|avi|mkv)$/i, "");
  const m = noExt.match(GROUP_RE);
  if (m && m[1] && m[2]) {
    return { group: m[1].toUpperCase(), date: m[2].toUpperCase() };
  }
  return { group: "Other", date: "—" };
}

const STEP_LABELS: Record<RunState["step"], string> = {
  idle: "idle",
  pull_from_drive: "Step 1/4 — pulling raw videos from Drive folder",
  pull_form_submissions: "Step 2/4 — pulling form-submission videos",
  detect_hands: "Step 3/4 — detecting hand segments + cutting clips",
  upload_clips_to_drive: "Step 4/4 — uploading clips to hand-off folder",
  done: "Done",
  error: "Failed — see log",
};

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export function ClippingDashboard({
  formSubmissions,
}: {
  formSubmissions: FormSubmission[];
}) {
  const [data, setData] = useState<ClipsApiResponse | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [uploadingFile, setUploadingFile] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  // Selected clip fileNames for bulk delete (Clipped pane).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  // Selected RAW filenames in Unclipped pane (for Clip-selected + Delete).
  const [rawSelected, setRawSelected] = useState<Set<string>>(new Set());
  const [deletingRaw, setDeletingRaw] = useState(false);
  // Selected FORM submissions (keyed by submission id). Tracked
  // separately from rawSelected because clipping a form involves an
  // extra step: downloading the Drive file first via
  // pull_form_submissions.
  const [formSelected, setFormSelected] = useState<Set<string>>(new Set());
  // UX state for the manual Refresh button. Polling sets the timestamp
  // silently so we can show "updated Ns ago"; only user clicks toggle
  // the spinner so the button visibly responds to clicks.
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  // Search + filter state — purely client-side, no backend involvement.
  const [search, setSearch] = useState("");
  const [unclippedFilter, setUnclippedFilter] =
    useState<"all" | "form" | "raw">("all");
  const [clippedFilter, setClippedFilter] =
    useState<"all" | "on-drive" | "local">("all");
  // The server keeps run.step="error" in memory until the next run starts,
  // which means a stale failure banner can hang around long after the work
  // was actually done (e.g. by a manual terminal invocation). Stash the
  // startedAt of any run the user has dismissed so polling can't bring
  // the banner back — but a NEW failed run (different startedAt) still
  // shows its own banner correctly.
  const [dismissedRunStartedAt, setDismissedRunStartedAt] = useState<
    string | null
  >(null);

  const refresh = useCallback(async (opts?: { fromUserClick?: boolean }) => {
    // Spin the Refresh button only on a USER click; silent polling
    // shouldn't flicker it. The user needs visible feedback that their
    // click registered, even when the underlying data is unchanged
    // (e.g. a long detect_hands step shows the same state for minutes).
    if (opts?.fromUserClick) setRefreshing(true);

    // Fetch the two endpoints INDEPENDENTLY so a single transient failure
    // (e.g. a brief Cloudflare/ngrok blip during a heavy detect_hands run)
    // doesn't lose the other call's data. Track whether ANY call succeeded
    // so we can auto-clear a stale error banner — earlier behaviour left
    // "Load failed" stuck on screen forever after one bad poll cycle.
    let anySucceeded = false;
    let lastError: string | null = null;

    try {
      const res = await fetch("/api/clips", { cache: "no-store" });
      if (res.ok) {
        setData((await res.json()) as ClipsApiResponse);
        anySucceeded = true;
      } else {
        lastError = `/api/clips HTTP ${res.status}`;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }

    try {
      const res = await fetch("/api/clipping/run", { cache: "no-store" });
      if (res.ok) {
        setRun((await res.json()) as RunState);
        anySucceeded = true;
      } else {
        lastError = `/api/clipping/run HTTP ${res.status}`;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }

    if (anySucceeded) {
      // Auto-dismiss any stale "Load failed" banner once the connection
      // recovers. The user shouldn't have to manually click "dismiss"
      // after a transient blip.
      setErrorBanner(null);
      setLastUpdated(Date.now());
    } else if (lastError) {
      setErrorBanner(`Refresh failed: ${lastError}`);
    }

    if (opts?.fromUserClick) {
      // Keep the spinner visible for ~300ms minimum so a fast (<10ms)
      // response still gives a noticeable visual confirmation.
      setTimeout(() => setRefreshing(false), 300);
    }
  }, []);

  // Initial load + poll every 2s while a clipping run is active.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!run?.running) return;
    const iv = setInterval(() => void refresh(), 2000);
    return () => clearInterval(iv);
  }, [run?.running, refresh]);

  const startRun = useCallback(async () => {
    setErrorBanner(null);
    try {
      const res = await fetch("/api/clipping/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as { state?: RunState; reason?: string };
      if (!res.ok) {
        setErrorBanner(json.reason ?? `HTTP ${res.status}`);
      }
      if (json.state) setRun(json.state);
    } catch (e) {
      setErrorBanner(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const uploadOne = useCallback(
    async (fileName: string) => {
      setUploadingFile(fileName);
      try {
        const res = await fetch(
          `/api/clips/${encodeURIComponent(fileName)}/upload`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
        );
        if (!res.ok) {
          const text = await res.text();
          setErrorBanner(`Upload failed for ${fileName}: ${text}`);
        }
        await refresh();
      } catch (e) {
        setErrorBanner(e instanceof Error ? e.message : String(e));
      } finally {
        setUploadingFile(null);
      }
    },
    [refresh],
  );

  const pipelineMissing = data?.error === "pipeline-not-found";
  const clips = data?.clips ?? [];
  const incoming = data?.incoming ?? [];

  // ---- Bulk selection / delete ----
  const toggleOne = useCallback((fileName: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }, []);

  // Select-all is computed AFTER filtering — see further down in this
  // component for `allVisibleSelected` / `toggleAll`. We need filteredClips
  // and filteredIncoming defined first, and those depend on `clips` /
  // `incoming` which depend on `data`, so the order matters.

  // When the clip list changes (refresh / delete), drop any selected names
  // that no longer exist so the count stays accurate.
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(clips.map((c) => c.fileName));
      const next = new Set<string>();
      for (const n of prev) if (live.has(n)) next.add(n);
      return next.size === prev.size ? prev : next;
    });
  }, [clips]);

  const deleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    const names = Array.from(selected);
    const ok = window.confirm(
      `Delete ${names.length} clip${names.length === 1 ? "" : "s"} from disk?\n\n` +
        names.slice(0, 8).join("\n") +
        (names.length > 8 ? `\n…and ${names.length - 8} more` : "") +
        "\n\nThe Drive copy (if uploaded) is NOT removed.",
    );
    if (!ok) return;
    setDeleting(true);
    setErrorBanner(null);
    try {
      const res = await fetch("/api/clips/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      const json = (await res.json()) as {
        deleted: string[];
        failed: { name: string; error: string }[];
        driveCopyRemains: string[];
      };
      if (!res.ok) {
        setErrorBanner(
          `Delete request failed (HTTP ${res.status})`,
        );
      } else if (json.failed.length > 0) {
        setErrorBanner(
          `Deleted ${json.deleted.length}; ${json.failed.length} failed: ` +
            json.failed
              .slice(0, 3)
              .map((f) => `${f.name} (${f.error})`)
              .join("; "),
        );
      } else if (json.driveCopyRemains.length > 0) {
        setErrorBanner(
          `Deleted ${json.deleted.length} clip(s). ${json.driveCopyRemains.length} still have a Drive copy — delete from Drive separately if you want them fully gone.`,
        );
      }
      setSelected(new Set());
      await refresh();
    } catch (e) {
      setErrorBanner(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }, [selected, refresh]);

  const summary = useMemo(() => {
    const uploaded = clips.filter((c) => c.driveFileId).length;
    const totalSize = clips.reduce((acc, c) => acc + c.sizeBytes, 0);
    return { uploaded, totalSize };
  }, [clips]);

  // Per-main upload state (Clipped pane). Maps main name -> in-flight
  // flag. We only ever have one upload running at a time (the API
  // sequences sub-groups internally), so a single state value is fine.
  const [uploadingMain, setUploadingMain] = useState<string | null>(null);

  const destinationName = data?.destination?.name ?? "Robot Video Pipeline";

  const uploadMainToDrive = useCallback(
    async (
      mainName: string,
      subGroups: Array<{ groupKey: string; clipNames: string[] }>,
    ) => {
      const totalClips = subGroups.reduce(
        (a, g) => a + g.clipNames.length,
        0,
      );
      if (totalClips === 0) return;
      const subSummary = subGroups
        .slice(0, 6)
        .map((g) => `  • ${g.groupKey}/  (${g.clipNames.length})`)
        .join("\n");
      const more =
        subGroups.length > 6 ? `\n  …and ${subGroups.length - 6} more` : "";
      const confirmed = window.confirm(
        `Upload ${totalClips} clip${totalClips === 1 ? "" : "s"} into ` +
          `"${destinationName}/${mainName}/"?\n\n` +
          `Sub-folders that will be created/reused:\n${subSummary}${more}` +
          "\n\nAlready-uploaded clips will be MOVED into their new " +
          "subfolder (metadata-only, no re-upload). Brand-new clips " +
          "will be uploaded.",
      );
      if (!confirmed) return;
      setUploadingMain(mainName);
      setErrorBanner(null);
      try {
        const res = await fetch("/api/clips/upload-main", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mainName, subGroups }),
        });
        // New manifest-mode response: one tally for the whole main
        // (moved + uploaded + failed counts) instead of per-sub-group
        // results. Partial success = 207 with failed>0.
        const json = (await res.json()) as {
          ok: boolean;
          moved?: number;
          uploaded?: number;
          failed?: number;
          folderUrl?: string | null;
          error?: string;
          destination?: DestinationFolder;
        };
        const destLabel = json.destination?.name ?? destinationName;
        if (!res.ok && res.status !== 207) {
          setErrorBanner(
            `Upload to ${destLabel}/${mainName}/ failed: ${json.error ?? `HTTP ${res.status}`}`,
          );
        } else if (!json.ok) {
          const moved = json.moved ?? 0;
          const uploaded = json.uploaded ?? 0;
          const failed = json.failed ?? 0;
          setErrorBanner(
            `Partial upload to ${destLabel}/${mainName}/: ${moved} moved, ` +
              `${uploaded} uploaded, ${failed} failed. See server logs.`,
          );
        }
        if (json.folderUrl) {
          window.open(json.folderUrl, "_blank", "noopener,noreferrer");
        }
        await refresh();
      } catch (e) {
        setErrorBanner(e instanceof Error ? e.message : String(e));
      } finally {
        setUploadingMain(null);
      }
    },
    [refresh, destinationName],
  );

  // ---- "Already clipped" lookup -------------------------------------
  // A RAW video is considered already-clipped if a file named
  // "<rawStem> (clipped).mp4" exists in the clips folder. The clipping
  // pipeline writes outputs with that exact pattern (see detect_hands.py
  // clip_segments()), so this is the authoritative check.
  //
  // Building a Set of clipped filenames once is O(N); per-row lookup
  // is O(1). Use the FULL clips list, not filteredClips — a hidden clip
  // (e.g. filtered out by "On Drive" chip) still counts as "clipped".
  const clippedNameSet = useMemo(
    () => new Set(clips.map((c) => c.fileName.toLowerCase())),
    [clips],
  );

  const isAlreadyClipped = useCallback(
    (rawFileName: string): boolean => {
      // Strip the trailing extension, then check for "<stem> (clipped).mp4".
      const m = rawFileName.match(/^(.+)\.(?:mp4|mov|avi|mkv)$/i);
      if (!m) return false;
      const stem = m[1];
      return clippedNameSet.has(`${stem} (clipped).mp4`.toLowerCase());
    },
    [clippedNameSet],
  );

  // FORM filenames may contain `/` (e.g. "c5e3dab720/rgb.mp4") because
  // the display name comes from Postgres before sanitization. The
  // clipped file on disk uses underscores. Same lookup, with the
  // sanitize step applied first.
  const isFormClipped = useCallback(
    (formFileName: string | null | undefined): boolean => {
      if (!formFileName) return false;
      const safe = formFileName.replace(/[\\/]/g, "_");
      const m = safe.match(/^(.+)\.(?:mp4|mov|avi|mkv)$/i);
      if (!m) return false;
      const stem = m[1];
      return clippedNameSet.has(`${stem} (clipped).mp4`.toLowerCase());
    },
    [clippedNameSet],
  );

  // ---- FORM selection helpers (Unclipped pane) ---------------------
  const toggleForm = useCallback((submissionId: string) => {
    setFormSelected((prev) => {
      const next = new Set(prev);
      if (next.has(submissionId)) next.delete(submissionId);
      else next.add(submissionId);
      return next;
    });
  }, []);

  // When forms get clipped, drop them from selection so the count stays
  // accurate (mirrors the rawSelected cleanup pattern).
  useEffect(() => {
    setFormSelected((prev) => {
      const live = new Set(formSubmissions.map((s) => s.id));
      const next = new Set<string>();
      for (const id of prev) {
        const sub = formSubmissions.find((s) => s.id === id);
        if (sub && live.has(id) && !isFormClipped(sub.fileName)) {
          next.add(id);
        }
      }
      return next.size === prev.size ? prev : next;
    });
  }, [formSubmissions, isFormClipped]);

  // ---- Filtering + search (client-side) ----
  // Case-insensitive substring match across filenames + submitter names
  // for FORM rows (so "dataops" finds Dave's submissions).
  const searchLower = search.trim().toLowerCase();
  const matchesSearch = useCallback(
    (...haystacks: Array<string | null | undefined>): boolean => {
      if (!searchLower) return true;
      return haystacks.some(
        (h) => typeof h === "string" && h.toLowerCase().includes(searchLower),
      );
    },
    [searchLower],
  );

  // The Unclipped pane is for videos that still need clipping — nothing
  // else. So we drop any row that:
  //   (a) already has a matching <stem> (clipped).mp4 on disk
  //       (caught by isFormClipped / isAlreadyClipped), OR
  //   (b) is itself a clipped file (name contains "(clipped)" — happens
  //       when someone uploads a previously-clipped file via the form,
  //       or when a clipped file shows up in incoming/ for some reason)
  // Together these guarantee the pane never lists something that's
  // already done, and the Clipped pane on the right remains the single
  // source of truth for "already clipped" content (just the clips/
  // folder, no FORM rows). The earlier "show clipped row with greyed
  // checkbox + badge" behavior is intentionally gone — the user asked
  // for a strict separation.
  const isClippedName = useCallback(
    (name: string | null | undefined): boolean =>
      typeof name === "string" && /\(clipped\)/i.test(name),
    [],
  );

  const filteredFormSubmissions = useMemo(() => {
    if (unclippedFilter === "raw") return [];
    return formSubmissions.filter(
      (s) =>
        !isFormClipped(s.fileName) &&
        !isClippedName(s.fileName) &&
        matchesSearch(
          s.fileName,
          s.submitterName,
          s.submitterEmail,
          s.category,
        ),
    );
  }, [
    formSubmissions,
    unclippedFilter,
    matchesSearch,
    isFormClipped,
    isClippedName,
  ]);

  const filteredIncoming = useMemo(() => {
    if (unclippedFilter === "form") return [];
    return incoming.filter(
      (f) =>
        !isAlreadyClipped(f.fileName) &&
        !isClippedName(f.fileName) &&
        matchesSearch(f.fileName),
    );
  }, [incoming, unclippedFilter, matchesSearch, isAlreadyClipped, isClippedName]);

  const filteredClips = useMemo(() => {
    return clips.filter((c) => {
      if (clippedFilter === "on-drive" && !c.driveFileId) return false;
      if (clippedFilter === "local" && c.driveFileId) return false;
      return matchesSearch(c.fileName, c.activityLabel);
    });
  }, [clips, clippedFilter, matchesSearch]);

  const filterActive =
    searchLower.length > 0 ||
    unclippedFilter !== "all" ||
    clippedFilter !== "all";

  const clearFilters = useCallback(() => {
    setSearch("");
    setUnclippedFilter("all");
    setClippedFilter("all");
  }, []);

  // ---- Group / date tree (for collapsible UI) ----------------------
  // Build a nested structure once per filtered* change. Maps preserve
  // insertion order so the UI doesn't reshuffle when an item finishes
  // uploading.
  type RawItem =
    | { kind: "form"; row: FormSubmission }
    | { kind: "raw"; row: IncomingRow };

  const unclippedGroups = useMemo(() => {
    type Tree = Map<string, Map<string, RawItem[]>>;
    const tree: Tree = new Map();
    const addToTree = (key: string, date: string, item: RawItem) => {
      if (!tree.has(key)) tree.set(key, new Map());
      const sub = tree.get(key)!;
      if (!sub.has(date)) sub.set(date, []);
      sub.get(date)!.push(item);
    };
    for (const s of filteredFormSubmissions) {
      const { group, date } = parseGroup(s.fileName ?? "");
      addToTree(group, date, { kind: "form", row: s });
    }
    for (const f of filteredIncoming) {
      const { group, date } = parseGroup(f.fileName);
      addToTree(group, date, { kind: "raw", row: f });
    }
    return tree;
  }, [filteredFormSubmissions, filteredIncoming]);

  // 3-level Main → Sub → Date tree. Main comes from the API's
  // `clip.main` field (resolved server-side from the source video's
  // top-level shared Drive folder, e.g. "Hotel 77"). Clips with no
  // resolved main fall into "Other" so they're still reachable.
  const clippedGroups = useMemo(() => {
    type DateMap = Map<string, ClipRow[]>;
    type SubMap = Map<string, DateMap>;
    type MainMap = Map<string, SubMap>;
    const tree: MainMap = new Map();
    for (const c of filteredClips) {
      // Strip " (clipped).mp4" so parseGroup can pull out the sub/date.
      const sourceName = c.fileName.replace(/ \(clipped\)\.mp4$/i, ".mp4");
      const { group: sub, date } = parseGroup(sourceName);
      const main = c.main ?? "Other";
      if (!tree.has(main)) tree.set(main, new Map());
      const subMap = tree.get(main)!;
      if (!subMap.has(sub)) subMap.set(sub, new Map());
      const dateMap = subMap.get(sub)!;
      if (!dateMap.has(date)) dateMap.set(date, []);
      dateMap.get(date)!.push(c);
    }
    return tree;
  }, [filteredClips]);

  // ---- Clipped select-all (operates on filtered/visible rows) ----
  const allVisibleSelected =
    filteredClips.length > 0 &&
    filteredClips.every((c) => selected.has(c.fileName));
  const someVisibleSelected =
    filteredClips.some((c) => selected.has(c.fileName)) && !allVisibleSelected;

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allFilteredAlreadyIn = filteredClips.every((c) =>
        next.has(c.fileName),
      );
      if (allFilteredAlreadyIn) {
        for (const c of filteredClips) next.delete(c.fileName);
      } else {
        for (const c of filteredClips) next.add(c.fileName);
      }
      return next;
    });
  }, [filteredClips]);

  // ---- Unclipped (RAW) selection helpers ----
  const toggleRaw = useCallback((fileName: string) => {
    setRawSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }, []);

  // Same pattern as Clipped: select-all toggles only the FILTERED raw
  // rows — AND only rows that aren't already clipped. We don't want a
  // single click to re-clip videos that already have a clipped output.
  const filteredSelectableRaw = useMemo(
    () => filteredIncoming.filter((f) => !isAlreadyClipped(f.fileName)),
    [filteredIncoming, isAlreadyClipped],
  );
  const allRawVisibleSelected =
    filteredSelectableRaw.length > 0 &&
    filteredSelectableRaw.every((f) => rawSelected.has(f.fileName));
  const someRawVisibleSelected =
    filteredSelectableRaw.some((f) => rawSelected.has(f.fileName)) &&
    !allRawVisibleSelected;

  const toggleAllRaw = useCallback(() => {
    setRawSelected((prev) => {
      const next = new Set(prev);
      const allFilteredAlreadyIn = filteredSelectableRaw.every((f) =>
        next.has(f.fileName),
      );
      if (allFilteredAlreadyIn) {
        for (const f of filteredSelectableRaw) next.delete(f.fileName);
      } else {
        for (const f of filteredSelectableRaw) next.add(f.fileName);
      }
      return next;
    });
  }, [filteredSelectableRaw]);

  // Drop selection entries that:
  //   (a) disappeared after a refresh, or
  //   (b) just got clipped (a refresh added their "<stem> (clipped).mp4")
  // So the visible selection count stays consistent with what's actually
  // selectable.
  useEffect(() => {
    setRawSelected((prev) => {
      const live = new Set(incoming.map((f) => f.fileName));
      const next = new Set<string>();
      for (const n of prev) {
        if (live.has(n) && !isAlreadyClipped(n)) next.add(n);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [incoming, isAlreadyClipped]);

  const clipSelectedRaw = useCallback(async () => {
    // Build the RAW + FORM payloads. RAW selections that are already
    // clipped get filtered; same for FORM. If the user somehow has
    // zero clippable items selected, show a hint and bail.
    const rawNames = Array.from(rawSelected).filter(
      (n) => !isAlreadyClipped(n),
    );
    const formItems: Array<{ driveFileId: string; fileName: string }> = [];
    for (const id of formSelected) {
      const sub = formSubmissions.find((s) => s.id === id);
      if (!sub || !sub.driveFileId || !sub.fileName) continue;
      if (isFormClipped(sub.fileName)) continue;
      formItems.push({
        driveFileId: sub.driveFileId,
        fileName: sub.fileName,
      });
    }
    if (rawNames.length === 0 && formItems.length === 0) {
      setErrorBanner(
        "Nothing clippable in your selection (already clipped or empty). Delete the existing clip first if you want to re-clip.",
      );
      return;
    }
    setErrorBanner(null);
    try {
      const res = await fetch("/api/clipping/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Skip the full Drive-folder pull (prune would delete the
          // files we just selected). The targeted form-pull still runs
          // server-side when selectedForms is non-empty.
          skipPull: true,
          selectedFiles: rawNames,
          selectedForms: formItems,
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        reason?: string;
        state?: RunState;
      };
      if (!res.ok || !json.ok) {
        setErrorBanner(json.reason ?? `HTTP ${res.status}`);
      }
      if (json.state) setRun(json.state);
      // Don't clear rawSelected — the user might want to see what's running.
      // It'll auto-clear when those files disappear from incoming/ on next refresh.
    } catch (e) {
      setErrorBanner(e instanceof Error ? e.message : String(e));
    }
  }, [rawSelected, isAlreadyClipped, formSelected, formSubmissions, isFormClipped]);

  const deleteSelectedRaw = useCallback(async () => {
    if (rawSelected.size === 0) return;
    const names = Array.from(rawSelected);
    const ok = window.confirm(
      `Delete ${names.length} raw video${names.length === 1 ? "" : "s"} from incoming/?\n\n` +
        names.slice(0, 8).join("\n") +
        (names.length > 8 ? `\n…and ${names.length - 8} more` : "") +
        "\n\nThe Drive copy is NOT removed — re-running the pipeline will re-download these.",
    );
    if (!ok) return;
    setDeletingRaw(true);
    setErrorBanner(null);
    try {
      const res = await fetch("/api/incoming/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      const json = (await res.json()) as {
        deleted: string[];
        failed: { name: string; error: string }[];
      };
      if (!res.ok) {
        setErrorBanner(`Delete request failed (HTTP ${res.status})`);
      } else if (json.failed.length > 0) {
        setErrorBanner(
          `Deleted ${json.deleted.length}; ${json.failed.length} failed: ` +
            json.failed
              .slice(0, 3)
              .map((f) => `${f.name} (${f.error})`)
              .join("; "),
        );
      }
      setRawSelected(new Set());
      await refresh();
    } catch (e) {
      setErrorBanner(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingRaw(false);
    }
  }, [rawSelected, refresh]);

  return (
    <div className="space-y-4">
      {/* Banner: pipeline path / errors */}
      {pipelineMissing ? (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          <strong>Clipping runs on the local operator instance.</strong>{" "}
          The Python pipeline (ffmpeg + MediaPipe + Drive auth) lives on
          the Mac, not on Railway. To run clipping, open this dashboard
          on the local machine:{" "}
          <a
            href="http://localhost:3000/admin/clipping"
            className="font-medium underline hover:text-blue-700"
          >
            http://localhost:3000/admin/clipping
          </a>
          . The submissions list below is still useful for review.
        </div>
      ) : null}
      {errorBanner ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {errorBanner}{" "}
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            className="ml-2 underline"
          >
            dismiss
          </button>
        </div>
      ) : null}

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
        {pipelineMissing ? null : (
          <button
            type="button"
            onClick={startRun}
            disabled={!!run?.running}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium",
              run?.running
                ? "cursor-not-allowed bg-slate-100 text-slate-400"
                : "bg-slate-900 text-white hover:bg-slate-700",
            )}
          >
            {run?.running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {run?.running ? "Running…" : "Run clipping now"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void refresh({ fromUserClick: true })}
          disabled={refreshing}
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm font-medium",
            refreshing
              ? "cursor-not-allowed bg-slate-100 text-slate-400"
              : "bg-white text-slate-700 hover:bg-slate-50",
          )}
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
        {lastUpdated ? (
          <span
            className="text-xs text-slate-400"
            title={new Date(lastUpdated).toLocaleString()}
          >
            updated {formatRelative(new Date(lastUpdated).toISOString())}
          </span>
        ) : null}
        {/* Search input — filters both panes live as you type. */}
        <div className="relative ml-2">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search filenames…"
            aria-label="Search clips and raw videos by filename"
            className="w-56 rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-7 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {filterActive ? (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <X className="h-3 w-3" />
            Clear filters
          </button>
        ) : null}
        <div className="ml-auto text-xs text-slate-500">
          {run ? (() => {
            // Hide the status text entirely when:
            //   - step is "idle" (default state — nothing useful to say)
            //   - the user already dismissed this failed run
            // Otherwise show the step label so users can see progress.
            if (run.step === "idle") return null;
            const dismissed =
              run.step === "error" &&
              run.startedAt !== null &&
              run.startedAt === dismissedRunStartedAt;
            if (dismissed) return null;
            return (
              <span>
                <strong className="font-medium text-slate-700">
                  {STEP_LABELS[run.step]}
                </strong>
                {run.startedAt ? (
                  <span className="ml-2">
                    started {formatRelative(run.startedAt)}
                  </span>
                ) : null}
              </span>
            );
          })() : null}
        </div>
      </div>

      {/* Inline failure banner with a hint extracted from the log tail. */}
      {run &&
      run.step === "error" &&
      run.log.length > 0 &&
      run.startedAt !== dismissedRunStartedAt ? (
        <div className="flex items-start gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              Clipping run failed (exit {run.exitCode ?? "?"}).
            </div>
            <div className="mt-1 font-mono text-xs leading-relaxed text-rose-800">
              {run.log
                .slice(-1)[0]
                ?.startsWith("-> exit")
                ? run.log.slice(-2)[0]
                : run.log.slice(-1)[0]}
            </div>
            {run.log.some((l) =>
              /invalid_scope|invalid_grant|RefreshError/.test(l),
            ) ? (
              <div className="mt-1 text-xs text-rose-800">
                Looks like the Google OAuth token is stale. The next "Run
                clipping now" will auto-detect this and pop up a browser
                window for you to re-authorize. Just click it again.
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setDismissedRunStartedAt(run.startedAt)}
            aria-label="Dismiss this error banner"
            className="shrink-0 rounded p-1 text-rose-700 hover:bg-rose-100"
            title="Hide this error. Re-runs that fail later will still show their own banner."
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* Live log — auto-open while running and when the run finishes
          (success or error). The user shouldn't have to hunt for it. */}
      {run && run.log.length > 0 && (run.running || run.step !== "idle") ? (
        <details
          open={run.running || run.step === "error" || run.step === "done"}
          className="rounded-md border border-slate-200 bg-slate-50"
        >
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-600">
            Live log ({run.log.length} lines)
          </summary>
          <pre className="max-h-64 overflow-auto px-3 pb-3 font-mono text-xs leading-relaxed text-slate-700">
            {run.log.join("\n")}
          </pre>
        </details>
      ) : null}

      {/* Split view */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Unclipped */}
        <section className="rounded-md border border-slate-200 bg-white">
          <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              {incoming.length > 0 ? (
                <input
                  type="checkbox"
                  aria-label="Select all raw videos"
                  checked={allRawVisibleSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someRawVisibleSelected;
                  }}
                  onChange={toggleAllRaw}
                  className="h-3.5 w-3.5 cursor-pointer accent-slate-700"
                  title="Select all RAW videos (FORM rows are managed by Postgres and not selectable here)"
                />
              ) : null}
              Unclipped
              <span className="ml-1 text-xs font-normal text-slate-400">
                {filterActive ? (
                  <>
                    {filteredFormSubmissions.length + filteredIncoming.length}{" "}
                    of {formSubmissions.length + incoming.length}
                  </>
                ) : (
                  <>
                    {formSubmissions.length + incoming.length} item
                    {formSubmissions.length + incoming.length === 1 ? "" : "s"}
                  </>
                )}
                {rawSelected.size + formSelected.size > 0
                  ? ` · ${rawSelected.size + formSelected.size} selected${
                      rawSelected.size > 0 && formSelected.size > 0
                        ? ` (${rawSelected.size} raw, ${formSelected.size} form)`
                        : formSelected.size > 0
                        ? " (form)"
                        : " (raw)"
                    }`
                  : ""}
              </span>
              {/* Source filter chips */}
              <span className="ml-2 inline-flex items-center gap-0.5 rounded-md border border-slate-200 bg-slate-50 p-0.5 text-[11px] font-medium">
                {(["all", "form", "raw"] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setUnclippedFilter(opt)}
                    className={clsx(
                      "rounded px-1.5 py-0.5",
                      unclippedFilter === opt
                        ? "bg-white text-slate-800 shadow-sm"
                        : "text-slate-500 hover:text-slate-700",
                    )}
                  >
                    {opt === "all" ? "All" : opt.toUpperCase()}
                  </button>
                ))}
              </span>
            </h2>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              {rawSelected.size + formSelected.size > 0 && !pipelineMissing ? (
                <>
                  <button
                    type="button"
                    onClick={() => void clipSelectedRaw()}
                    disabled={!!run?.running}
                    className={clsx(
                      "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium",
                      run?.running
                        ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                        : "border-slate-200 bg-slate-900 text-white hover:bg-slate-700",
                    )}
                    title={
                      formSelected.size > 0
                        ? "Download (if needed) + clip the selected FORM/RAW videos only"
                        : "Run detect_hands.py on the selected RAW videos only"
                    }
                  >
                    {run?.running ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    Clip {rawSelected.size + formSelected.size}
                  </button>
                  {rawSelected.size > 0 ? (
                    <button
                      type="button"
                      onClick={() => void deleteSelectedRaw()}
                      disabled={deletingRaw}
                      className={clsx(
                        "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium",
                        deletingRaw
                          ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                          : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
                      )}
                      title="Delete the selected RAW files from incoming/ (FORM rows can't be deleted from here — they live in Postgres/Drive)"
                    >
                      {deletingRaw ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      Delete {rawSelected.size} raw
                    </button>
                  ) : null}
                </>
              ) : (
                <span>Drive + Forms</span>
              )}
            </div>
          </header>

          {formSubmissions.length === 0 && incoming.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-400">
              Nothing waiting. Submit a Form response or drop a video into{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                ~/robot-video-pipeline/incoming/
              </code>
              .
            </p>
          ) : filteredFormSubmissions.length === 0 &&
            filteredIncoming.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-400">
              No items match the current search/filter.{" "}
              <button
                type="button"
                onClick={clearFilters}
                className="text-blue-600 hover:underline"
              >
                Clear
              </button>
              .
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {Array.from(unclippedGroups.entries()).map(
                ([groupName, dateMap]) => {
                  const groupCount = Array.from(dateMap.values()).reduce(
                    (a, arr) => a + arr.length,
                    0,
                  );
                  return (
                    <details
                      key={`grp-${groupName}`}
                      open
                      className="group"
                    >
                      <summary className="flex cursor-pointer items-center gap-2 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                        <span>{groupName}</span>
                        <span className="text-slate-400">
                          ({groupCount})
                        </span>
                      </summary>
                      {Array.from(dateMap.entries()).map(
                        ([dateName, items]) => (
                          <details
                            key={`grp-${groupName}-${dateName}`}
                            open
                            className="group/date border-t border-slate-100"
                          >
                            <summary className="flex cursor-pointer items-center gap-2 px-6 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50">
                              <ChevronRight className="h-2.5 w-2.5 transition-transform group-open/date:rotate-90" />
                              <span>{dateName}</span>
                              <span className="text-slate-400">
                                ({items.length})
                              </span>
                            </summary>
                            <ul className="divide-y divide-slate-100">
                              {items.map((it) =>
                                it.kind === "form" ? (() => {
                                  const formRow = it.row;
                                  const clipped = isFormClipped(formRow.fileName);
                                  // Disable checkbox when:
                                  //   - clip already exists, OR
                                  //   - we have no Drive file ID to pull from
                                  //     (very rare, only legacy rows)
                                  const disabled =
                                    clipped || !formRow.driveFileId;
                                  return (
                                  <li
                                    key={`form-${formRow.id}`}
                                    className={clsx(
                                      "flex items-start gap-3 px-3 py-2",
                                      formSelected.has(formRow.id)
                                        ? "bg-slate-50"
                                        : null,
                                      clipped ? "opacity-60" : null,
                                    )}
                                  >
                                    <input
                                      type="checkbox"
                                      aria-label={
                                        clipped
                                          ? `Already clipped: ${formRow.fileName ?? "form submission"}`
                                          : `Select form submission ${formRow.fileName ?? formRow.id}`
                                      }
                                      title={
                                        clipped
                                          ? "Already clipped — delete the existing clip first if you want to re-clip"
                                          : !formRow.driveFileId
                                          ? "No Drive file attached to this submission"
                                          : "Selecting this triggers a download + clip when you hit Clip-N"
                                      }
                                      checked={formSelected.has(formRow.id)}
                                      onChange={() => toggleForm(formRow.id)}
                                      disabled={disabled}
                                      className={clsx(
                                        "mt-1 h-3.5 w-3.5 accent-slate-700",
                                        disabled
                                          ? "cursor-not-allowed"
                                          : "cursor-pointer",
                                      )}
                                    />
                                    <span className="mt-0.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
                                      form
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-medium text-slate-800">
                                        {formRow.fileName ?? "(no file attached)"}
                                      </div>
                                      <div className="truncate text-xs text-slate-500">
                                        {formRow.submitterName} ·{" "}
                                        {formRow.category || "—"} ·{" "}
                                        {formatRelative(formRow.createdAt)}
                                      </div>
                                    </div>
                                    <span className="shrink-0 text-xs text-slate-400">
                                      {formatDuration(formRow.durationSec)}
                                    </span>
                                    {formRow.driveFileId ? (
                                      <a
                                        href={`https://drive.google.com/file/d/${formRow.driveFileId}/view`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="shrink-0 text-xs text-blue-600 hover:underline"
                                      >
                                        Drive
                                      </a>
                                    ) : null}
                                    {clipped ? (
                                      <span
                                        className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700"
                                        title="A clipped version of this form submission already exists"
                                      >
                                        <CheckCircle2 className="h-3 w-3" />
                                        clipped
                                      </span>
                                    ) : null}
                                  </li>
                                  );
                                })() : (() => {
                                  const f = it.row;
                                  const clipped = isAlreadyClipped(f.fileName);
                                  return (
                                    <li
                                      key={`raw-${f.fileName}`}
                                      className={clsx(
                                        "flex items-start gap-3 px-3 py-2",
                                        rawSelected.has(f.fileName)
                                          ? "bg-slate-50"
                                          : null,
                                        clipped ? "opacity-60" : null,
                                      )}
                                    >
                                      <input
                                        type="checkbox"
                                        aria-label={
                                          clipped
                                            ? `Already clipped: ${f.fileName}`
                                            : `Select ${f.fileName}`
                                        }
                                        title={
                                          clipped
                                            ? "Already clipped — delete the existing clip first if you want to re-clip"
                                            : undefined
                                        }
                                        checked={rawSelected.has(f.fileName)}
                                        onChange={() => toggleRaw(f.fileName)}
                                        disabled={clipped}
                                        className={clsx(
                                          "mt-1 h-3.5 w-3.5 accent-slate-700",
                                          clipped
                                            ? "cursor-not-allowed"
                                            : "cursor-pointer",
                                        )}
                                      />
                                      <span className="mt-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                                        raw
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm font-medium text-slate-800">
                                          {f.fileName}
                                        </div>
                                        <div className="truncate text-xs text-slate-500">
                                          {formatBytes(f.sizeBytes)} ·{" "}
                                          {formatRelative(f.mtime)}
                                        </div>
                                      </div>
                                      {clipped ? (
                                        <span
                                          className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700"
                                          title="A clipped version of this raw video already exists"
                                        >
                                          <CheckCircle2 className="h-3 w-3" />
                                          clipped
                                        </span>
                                      ) : null}
                                    </li>
                                  );
                                })(),
                              )}
                            </ul>
                          </details>
                        ),
                      )}
                    </details>
                  );
                },
              )}
            </div>
          )}
        </section>

        {/* Clipped */}
        <section className="rounded-md border border-slate-200 bg-white">
          <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              {clips.length > 0 ? (
                <input
                  type="checkbox"
                  aria-label="Select all clips"
                  checked={allVisibleSelected}
                  ref={(el) => {
                    // Indeterminate is a DOM-only prop, not exposed via JSX.
                    if (el) el.indeterminate = someVisibleSelected;
                  }}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 cursor-pointer accent-slate-700"
                />
              ) : null}
              Clipped
              <span className="ml-1 text-xs font-normal text-slate-400">
                {filterActive ? (
                  <>
                    {filteredClips.length} of {clips.length}
                  </>
                ) : (
                  <>
                    {clips.length} clip{clips.length === 1 ? "" : "s"}
                  </>
                )}
                {summary.uploaded > 0
                  ? ` · ${summary.uploaded} on Drive`
                  : ""}
                {selected.size > 0
                  ? ` · ${selected.size} selected`
                  : ""}
              </span>
              {/* Status filter chips */}
              <span className="ml-2 inline-flex items-center gap-0.5 rounded-md border border-slate-200 bg-slate-50 p-0.5 text-[11px] font-medium">
                {(
                  [
                    ["all", "All"],
                    ["on-drive", "On Drive"],
                    ["local", "Local only"],
                  ] as const
                ).map(([opt, label]) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setClippedFilter(opt)}
                    className={clsx(
                      "rounded px-1.5 py-0.5",
                      clippedFilter === opt
                        ? "bg-white text-slate-800 shadow-sm"
                        : "text-slate-500 hover:text-slate-700",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </h2>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-medium text-slate-600"
                title={
                  data?.destination?.id
                    ? `Drive folder ID: ${data.destination.id}`
                    : "Destination not configured — using Python script default. Set HANDOFF_DRIVE_FOLDER_ID in .env to override."
                }
              >
                <FolderUp className="h-3.5 w-3.5" />
                Uploads to: {destinationName}/
              </span>
              {selected.size > 0 ? (
                <button
                  type="button"
                  onClick={() => void deleteSelected()}
                  disabled={deleting}
                  className={clsx(
                    "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium",
                    deleting
                      ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                      : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
                  )}
                >
                  {deleting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  Delete {selected.size}
                </button>
              ) : null}
              {summary.totalSize > 0 ? (
                <span>{formatBytes(summary.totalSize)}</span>
              ) : null}
            </div>
          </header>

          {clips.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-400">
              No clips yet. Hit <em>Run clipping now</em> once you have raw
              videos.
            </p>
          ) : filteredClips.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-400">
              No clips match the current search/filter.{" "}
              <button
                type="button"
                onClick={clearFilters}
                className="text-blue-600 hover:underline"
              >
                Clear
              </button>
              .
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {Array.from(clippedGroups.entries()).map(
                ([mainName, subMap]) => {
                  // Total clips under this main (across all subs/dates).
                  const mainCount = Array.from(subMap.values()).reduce(
                    (a, dateMap) =>
                      a +
                      Array.from(dateMap.values()).reduce(
                        (b, arr) => b + arr.length,
                        0,
                      ),
                    0,
                  );
                  // Build the per-sub-group payload for the upload API:
                  //   [{ groupKey: "VPM0166_23MAY", clipNames: [...] }, …]
                  // The "Other" main uses a sanitised key prefix so it
                  // still maps to a real (if generic) Drive folder.
                  const subGroupPayload: Array<{
                    groupKey: string;
                    clipNames: string[];
                  }> = [];
                  for (const [subName, dateMap] of subMap) {
                    for (const [dateName, items] of dateMap) {
                      const groupKey =
                        subName === "Other"
                          ? `Other_${dateName}`.replace(/—/g, "misc")
                          : `${subName}_${dateName}`;
                      subGroupPayload.push({
                        groupKey,
                        clipNames: items.map((c) => c.fileName),
                      });
                    }
                  }
                  const busy = uploadingMain === mainName;
                  return (
                    <details
                      key={`clp-main-${mainName}`}
                      open
                      className="group/main"
                    >
                      <summary className="flex cursor-pointer items-center gap-2 bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-200">
                        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open/main:rotate-90" />
                        <span>{mainName}</span>
                        <span className="text-slate-500">
                          ({mainCount})
                        </span>
                        {pipelineMissing ? null : (
                          <button
                            type="button"
                            // The button lives inside the <summary>, so
                            // a click would toggle the <details>. Stop
                            // propagation + preventDefault so we can
                            // upload without collapsing the section.
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void uploadMainToDrive(mainName, subGroupPayload);
                            }}
                            disabled={busy || mainCount === 0}
                            title={
                              `Upload all ${mainCount} clip(s) under "${mainName}" ` +
                              `into Drive folder ${mainName}/<sub>_<date>/.`
                            }
                            className={clsx(
                              "ml-auto inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium",
                              busy
                                ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                            )}
                          >
                            {busy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <FolderUp className="h-3.5 w-3.5" />
                            )}
                            Upload to {mainName}/
                          </button>
                        )}
                      </summary>
                      {Array.from(subMap.entries()).map(
                        ([subName, dateMap]) => {
                          const subCount = Array.from(
                            dateMap.values(),
                          ).reduce((a, arr) => a + arr.length, 0);
                          return (
                            <details
                              key={`clp-${mainName}-${subName}`}
                              open
                              className="group/sub border-t border-slate-100"
                            >
                              <summary className="flex cursor-pointer items-center gap-2 bg-slate-50 px-6 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                                <ChevronRight className="h-3 w-3 transition-transform group-open/sub:rotate-90" />
                                <span>{subName}</span>
                                <span className="text-slate-400">
                                  ({subCount})
                                </span>
                              </summary>
                              {Array.from(dateMap.entries()).map(
                                ([dateName, items]) => {
                                  return (
                                    <details
                                      key={`clp-${mainName}-${subName}-${dateName}`}
                                      open
                                      className="group/date border-t border-slate-100"
                                    >
                                      <summary className="flex cursor-pointer items-center gap-2 px-10 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50">
                                        <ChevronRight className="h-2.5 w-2.5 transition-transform group-open/date:rotate-90" />
                                        <span>{dateName}</span>
                                        <span className="text-slate-400">
                                          ({items.length})
                                        </span>
                                      </summary>
                              <ul className="divide-y divide-slate-100">
                                {items.map((c) => (
                                  <li
                                    key={c.clipId}
                                    className={clsx(
                                      "flex items-start gap-3 px-3 py-2",
                                      selected.has(c.fileName)
                                        ? "bg-slate-50"
                                        : null,
                                    )}
                                  >
                                    <input
                                      type="checkbox"
                                      aria-label={`Select ${c.fileName}`}
                                      checked={selected.has(c.fileName)}
                                      onChange={() => toggleOne(c.fileName)}
                                      className="mt-1 h-3.5 w-3.5 cursor-pointer accent-slate-700"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-medium text-slate-800">
                                        {c.fileName}
                                      </div>
                                      <div className="truncate text-xs text-slate-500">
                                        {formatBytes(c.sizeBytes)} ·{" "}
                                        {formatDuration(c.durationSeconds)} ·{" "}
                                        {formatRelative(c.mtime)}
                                        {c.activityLabel
                                          ? ` · ${c.activityLabel}`
                                          : ""}
                                      </div>
                                    </div>
                                    <a
                                      href={`/api/clips/${encodeURIComponent(c.fileName)}/download`}
                                      download={c.fileName}
                                      title="Download MP4"
                                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                                    >
                                      <Download className="h-3.5 w-3.5" />
                                      Download
                                    </a>
                                    {c.driveFileId ? (
                                      <a
                                        href={`https://drive.google.com/file/d/${c.driveFileId}/view`}
                                        target="_blank"
                                        rel="noreferrer"
                                        title={`On Drive (uploaded ${
                                          c.uploadedAt
                                            ? formatRelative(c.uploadedAt)
                                            : "?"
                                        })`}
                                        className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                                      >
                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                        On Drive
                                      </a>
                                    ) : pipelineMissing ? null : (
                                      <button
                                        type="button"
                                        onClick={() => void uploadOne(c.fileName)}
                                        disabled={uploadingFile === c.fileName}
                                        title="Push to hand-off Drive folder"
                                        className={clsx(
                                          "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium",
                                          uploadingFile === c.fileName
                                            ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                                            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                                        )}
                                      >
                                        {uploadingFile === c.fileName ? (
                                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                          <Upload className="h-3.5 w-3.5" />
                                        )}
                                        Upload
                                      </button>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </details>
                                  );
                                },
                              )}
                            </details>
                          );
                        },
                      )}
                    </details>
                  );
                },
              )}
            </div>
          )}
        </section>
      </div>

      <p className="text-xs text-slate-400">
        Clips folder:{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5">
          {data?.clipsDir ?? "—"}
        </code>{" "}
        · Pipeline:{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5">
          {data?.pipelineRoot ?? "—"}
        </code>{" "}
        · <Link href="/admin" className="text-blue-600 hover:underline">
          back to submissions
        </Link>
      </p>
    </div>
  );
}
