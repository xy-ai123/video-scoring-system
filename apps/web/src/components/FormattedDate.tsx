"use client";

import { useEffect, useState } from "react";

/**
 * Render a timestamp without triggering Next.js hydration warnings.
 *
 * The server renders the date in UTC (a stable, locale-independent string).
 * After the client mounts, we replace it with the visitor's local-timezone
 * representation. Without this, server-rendered HTML (UTC) would differ from
 * the post-hydration HTML (local time on the visitor's phone) and Next.js
 * would flag a hydration mismatch — which surfaces as a red "1 error" badge
 * in the dev overlay.
 *
 * Pass `dateOnly` to drop the time component — used by columns that
 * record a calendar day rather than an instant (e.g. the phone
 * inventory's Rented Out date column, where the time-of-day was always
 * meaningless noise).
 */
export function FormattedDate({
  iso,
  dateOnly = false,
}: {
  iso: string | Date;
  dateOnly?: boolean;
}) {
  const isoStr = typeof iso === "string" ? iso : iso.toISOString();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  if (!hydrated) {
    // Stable representation. For dateOnly we use just the YYYY-MM-DD
    // prefix; for the regular case we keep the existing "YYYY-MM-DD HH:MM
    // UTC" shape so other callers don't change.
    return (
      <span suppressHydrationWarning>
        {dateOnly
          ? isoStr.slice(0, 10)
          : `${isoStr.slice(0, 16).replace("T", " ")} UTC`}
      </span>
    );
  }
  const localDate = new Date(isoStr);
  return (
    <span suppressHydrationWarning>
      {dateOnly ? localDate.toLocaleDateString() : localDate.toLocaleString()}
    </span>
  );
}
