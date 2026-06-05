"use client";

import { useCallback, useState } from "react";
import clsx from "clsx";
import { Loader2, PlayCircle, RefreshCw } from "lucide-react";

type HandoffFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  modifiedTime: string | null;
  webViewLink: string;
  durationSec: number | null;
};

type ScoreResult =
  | {
      ok: true;
      scores: Record<string, number>;
      summary?: string;
    }
  | {
      ok: false;
      reason: string;
      message: string;
    };

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function AlgoDashboard({
  files,
  engineConfigured,
}: {
  files: HandoffFile[];
  engineConfigured: boolean;
}) {
  const [results, setResults] = useState<Record<string, ScoreResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const runOne = useCallback(async (fileId: string) => {
    setBusy(fileId);
    setBanner(null);
    try {
      const res = await fetch("/api/algo/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
      const json = (await res.json()) as ScoreResult;
      setResults((prev) => ({ ...prev, [fileId]: json }));
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <div className="space-y-4">
      {!engineConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>Algorithm engine is not configured.</strong> Buttons below
          still work but will return a friendly “not ready yet” message.
          Wire <code className="rounded bg-amber-100 px-1">ALGO_ENGINE_URL</code>{" "}
          and{" "}
          <code className="rounded bg-amber-100 px-1">ALGO_ENGINE_API_KEY</code>{" "}
          in <code className="rounded bg-amber-100 px-1">.env</code> when the
          engine is online, then port the multipart POST from{" "}
          <code className="rounded bg-amber-100 px-1">
            apps/worker/src/services/algorithmEngine.ts
          </code>{" "}
          into{" "}
          <code className="rounded bg-amber-100 px-1">
            apps/web-algo/src/lib/algoEngine.ts
          </code>
          .
        </div>
      ) : null}

      {banner ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {banner}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600">
          {files.length} file{files.length === 1 ? "" : "s"} in hand-off
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <ul className="divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200 bg-white">
        {files.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-slate-400">
            No videos in the hand-off folder yet. Clipping pipeline will
            push them here when it runs.
          </li>
        ) : null}
        {files.map((f) => {
          const r = results[f.id];
          return (
            <li
              key={f.id}
              className="flex items-start gap-3 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-800">
                  <a
                    href={f.webViewLink}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    {f.name}
                  </a>
                </div>
                <div className="truncate text-xs text-slate-500">
                  {fmtBytes(f.sizeBytes)} · {fmtDuration(f.durationSec)} ·{" "}
                  {fmtRelative(f.modifiedTime)}
                </div>
                {r ? (
                  <div
                    className={clsx(
                      "mt-1 rounded px-2 py-1 text-xs",
                      r.ok
                        ? "bg-emerald-50 text-emerald-900"
                        : "bg-slate-50 text-slate-700",
                    )}
                  >
                    {r.ok ? (
                      <>
                        <strong>scores:</strong>{" "}
                        {Object.entries(r.scores)
                          .map(([k, v]) => `${k}=${v.toFixed(2)}`)
                          .join(", ")}
                        {r.summary ? ` — ${r.summary}` : ""}
                      </>
                    ) : (
                      <span title={r.reason}>{r.message}</span>
                    )}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => void runOne(f.id)}
                disabled={busy === f.id}
                className={clsx(
                  "shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium",
                  busy === f.id
                    ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                )}
              >
                {busy === f.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PlayCircle className="h-3.5 w-3.5" />
                )}
                Send to engine
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
