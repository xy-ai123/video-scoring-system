-- Add per-file counter for failed duration probes. See schema.prisma's
-- VideoFile.durationProbeAttempts doc comment for the full rationale.

ALTER TABLE "VideoFile"
  ADD COLUMN "durationProbeAttempts" INTEGER NOT NULL DEFAULT 0;

-- Backfill: any row that's already null OR 0 has effectively had at
-- least one failed/junk probe attempt. Start them at 1 so the dashboard
-- doesn't flag them as CORRUPT immediately (threshold is 3) — we want
-- the next 2-3 sync ticks to retry them before declaring them broken.
-- New rows (default 0) start fresh and only count actual attempts.
UPDATE "VideoFile"
   SET "durationProbeAttempts" = 1
 WHERE "durationSec" IS NULL OR "durationSec" = 0;
