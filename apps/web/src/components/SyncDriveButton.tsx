"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type SyncState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  log: string[];
  result: {
    scanned: number;
    ingested: number;
    durationsBackfilled: number;
    softDeleted: number;
    errors: number;
  } | null;
};

/**
 * Header button that pulls every Drive folder shared with the worker SA
 * into the dashboard — picks up new uploads, renames, and removals.
 *
 * Polling cadence: 2s while running. Once finished, we router.refresh()
 * once so the server-rendered table reflects the new rows immediately.
 */
export function SyncDriveButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<SyncState["result"]>(null);
  const [error, setError] = useState<string | null>(null);
  const pollHandle = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollHandle.current) {
      clearInterval(pollHandle.current);
      pollHandle.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/sync-drive", { cache: "no-store" });
      if (!r.ok) return;
      const s: SyncState = await r.json();
      setRunning(s.running);
      if (!s.running) {
        stopPolling();
        setLastResult(s.result);
        // Server-rendered submissions list is stale — refresh it so the
        // newly-ingested rows appear without the user having to reload.
        router.refresh();
      }
    } catch {
      // Network blip — keep polling, the next tick will retry.
    }
  }, [router, stopPolling]);

  // If a sync was already running when this component mounted (e.g.
  // user navigated to /admin from another page mid-sync), pick it up
  // and resume polling so the spinner doesn't lie.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/admin/sync-drive", { cache: "no-store" });
        if (!r.ok || cancelled) return;
        const s: SyncState = await r.json();
        if (s.running) {
          setRunning(true);
          pollHandle.current = setInterval(poll, 2000);
        } else if (s.result) {
          setLastResult(s.result);
        }
      } catch {
        // Ignore — the button still works, just no resume state.
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [poll, stopPolling]);

  async function handleClick() {
    if (running) return;
    setError(null);
    setLastResult(null);
    setRunning(true);
    try {
      const r = await fetch("/api/admin/sync-drive", { method: "POST" });
      if (r.status === 409) {
        // Another tab/session started one — just start polling.
        pollHandle.current = setInterval(poll, 2000);
        return;
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { reason?: string }
          | null;
        setError(body?.reason ?? `HTTP ${r.status}`);
        setRunning(false);
        return;
      }
      pollHandle.current = setInterval(poll, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
      setRunning(false);
    }
  }

  // Build the result label. Counts come from the rawTotals object the
  // script logs right before exit; if it didn't parse cleanly we just
  // say "synced" so the user knows the run finished.
  let resultLabel: string | null = null;
  if (!running && lastResult) {
    const bits: string[] = [];
    if (lastResult.ingested > 0) bits.push(`+${lastResult.ingested} new`);
    if (lastResult.softDeleted > 0)
      bits.push(`-${lastResult.softDeleted} removed`);
    if (lastResult.durationsBackfilled > 0)
      bits.push(`${lastResult.durationsBackfilled} updated`);
    if (lastResult.errors > 0) bits.push(`${lastResult.errors} errors`);
    resultLabel = bits.length > 0 ? bits.join(", ") : "no changes";
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={handleClick}
        disabled={running}
        title="Pull new / renamed / removed videos from every Drive folder shared with the worker"
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`}
        />
        {running ? "Syncing Drive…" : "Sync Drive"}
      </button>
      {resultLabel && (
        <span className="text-slate-500" title="Result of the last sync">
          {resultLabel}
        </span>
      )}
      {error && (
        <span className="text-rose-600" title={error}>
          sync failed: {error}
        </span>
      )}
    </div>
  );
}
