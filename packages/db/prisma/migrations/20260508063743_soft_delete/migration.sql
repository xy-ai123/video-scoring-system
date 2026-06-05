-- Soft delete columns on Submission.
ALTER TABLE "Submission" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Submission" ADD COLUMN "deletedBy" TEXT;

-- Index for filtering active vs deleted rows.
CREATE INDEX "Submission_deletedAt_idx" ON "Submission"("deletedAt");
