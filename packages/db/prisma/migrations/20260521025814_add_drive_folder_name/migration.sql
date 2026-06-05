-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "driveFolderName" TEXT;

-- Backfill: every existing Drive- or ZIP-ingested submission (the
-- `responseId` is synthesised at ingest time as `drive-<fileId>` or
-- `zip-<entryHash>`) currently carries the parent folder name in
-- `category`. Copy that into the new column, then blank out `category` so
-- operators see the new "empty + editable" UX on the dashboard. Form
-- submissions (which have responseIds shaped like the Google Forms
-- response id, not our synthetic prefix) are untouched.
UPDATE "Submission"
SET "driveFolderName" = "category"
WHERE "responseId" LIKE 'drive-%' OR "responseId" LIKE 'zip-%';

UPDATE "Submission"
SET "category" = ''
WHERE "responseId" LIKE 'drive-%' OR "responseId" LIKE 'zip-%';
