/**
 * Human-friendly duration formatting.
 *
 * Sub-hour values render as `m:ss` (e.g. "0:42", "12:05"); anything ≥1 hour
 * renders as `h:mm:ss` (e.g. "1:02:30"). Returns "—" for null/NaN inputs so
 * the UI degrades cleanly when Drive hasn't reported metadata yet.
 *
 * Zero (and negative) values also render as "—" — a 0-second measurement
 * is almost always a junk read (Drive's videoMediaMetadata wasn't ready
 * at probe time, ffprobe couldn't decode the tail, file partially
 * uploaded). Treating it like "not yet measured" hides the misleading
 * "0:00" cell AND makes the Phase 2 backfill loop (which now retries
 * `durationSec === 0` rows) feel naturally aligned with what's shown.
 */
export function formatDurationSec(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Longer-form label: "1h 02m 30s" / "12m 05s" / "42s". Useful for the
 *  dashboard total card where the value gets a lot of visual weight.
 *  Same zero-as-unknown treatment as formatDurationSec above. */
export function formatDurationVerbose(
  value: number | null | undefined,
): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}
