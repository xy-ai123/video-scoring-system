"use client";

import { useEffect, useState } from "react";

/**
 * Small client-side "we noticed a new main!" badge.
 *
 * On every dashboard load this component:
 *   1. Reads the set of mains it remembered from a prior load (via
 *      localStorage). Cold first-ever visit returns an empty set.
 *   2. Diffs the incoming `knownMains` against the remembered set.
 *   3. If the diff is non-empty AND the remembered set was non-empty
 *      (so we're not flagging the entire world on a virgin browser),
 *      shows a small green chip listing the new mains for ~8 seconds.
 *   4. Persists the new full set, regardless of whether the badge
 *      showed — so the next load doesn't re-flag the same names.
 *
 * Why a client component (not server-side)?
 * The "we already saw this" memory has to be per-browser. A
 * server-side memory (file/DB) would mark Restaurant CM as "no longer
 * new" after the FIRST admin viewed it, leaving every other admin
 * unaware. localStorage gives each browser its own correct signal.
 *
 * Why no animation library?
 * One badge that fades out via a timeout. Keeping it dependency-free.
 */

const STORAGE_KEY = "vss:knownMains:seen:v1";
const SHOW_DURATION_MS = 8_000;

type Props = {
  /** Latest set of mains the dashboard knows about, server-rendered.
   *  Order doesn't matter — we compare as sets. */
  knownMains: string[];
};

export function NewMainBadge({ knownMains }: Props) {
  const [newMains, setNewMains] = useState<string[]>([]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const prevArr: string[] = raw ? JSON.parse(raw) : [];
      const prev = new Set(Array.isArray(prevArr) ? prevArr : []);
      const fresh = knownMains.filter((m) => !prev.has(m));

      // Only flag if we had a prior baseline. First-ever visit would
      // otherwise mark literally every existing main as "new" — that's
      // a noisy false positive, not an insight.
      if (fresh.length > 0 && prev.size > 0) {
        setNewMains(fresh);
        timer = setTimeout(() => setNewMains([]), SHOW_DURATION_MS);
      }

      // Always overwrite — both removals and additions roll forward.
      // Worst case (quota/private mode): the catch below swallows it
      // and the badge re-fires next refresh until storage is healthy.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(knownMains));
    } catch {
      // Quota exceeded / private mode / corrupt JSON — silent no-op.
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [knownMains]);

  if (newMains.length === 0) return null;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
      title="A new top-level Drive folder is now visible to the dashboard. Click around to filter by it."
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
      NEW main detected: {newMains.join(", ")}
    </span>
  );
}
