/**
 * Next.js instrumentation hook — runs ONCE per server process at startup,
 * after the framework is up but before the first request is served.
 *
 * Used here to schedule the Drive auto-sync timer. See
 * `lib/driveSync.ts → startAutoSyncTimer()` for the cadence + behaviour.
 *
 * Why this file (and not a route handler / middleware): instrumentation
 * is the ONLY Next.js hook that:
 *   1. Fires exactly once on cold start (not per request).
 *   2. Has access to Node.js APIs (timers, child_process), so we can
 *      run a long-lived setInterval that survives across requests.
 *   3. Is officially supported by Next.js 14 (stable since 14.0). No
 *      experimental flags needed.
 *
 * The function is guarded by `process.env.NEXT_RUNTIME === "nodejs"`
 * so it never accidentally runs in the Edge runtime (which doesn't
 * have child_process and would crash the auto-sync spawn).
 *
 * Set AUTO_SYNC_INTERVAL_MIN=0 in the environment to disable auto-sync
 * entirely (useful for local dev when you don't want background spawns).
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAutoSyncTimer } = await import("./lib/driveSync");
  startAutoSyncTimer();
}
