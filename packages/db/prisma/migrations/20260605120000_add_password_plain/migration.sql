-- Add plaintext mirror column on AdminUser + GuestUser so the dashboard
-- can show the current password to operators. See schema.prisma for the
-- security trade-off comment.

ALTER TABLE "AdminUser" ADD COLUMN "passwordPlain" TEXT;
ALTER TABLE "GuestUser" ADD COLUMN "passwordPlain" TEXT;

-- Best-effort backfill of plaintext for rows seeded with known defaults.
-- Only writes when the row's username matches AND the plaintext column is
-- still NULL — so we never clobber a value the application code may have
-- already written, and we never lie about a password that has since been
-- changed (operator-changed passwords leave the column NULL and the UI
-- shows "—" until they save once again).
--
-- These default plaintexts come from the seeders in
-- apps/web/src/lib/adminUser.ts and apps/web/src/lib/guestUser.ts.
UPDATE "AdminUser"
   SET "passwordPlain" = 'admin123'
 WHERE "username" = 'admin'
   AND "passwordPlain" IS NULL;

UPDATE "GuestUser"
   SET "passwordPlain" = 'hotel77123'
 WHERE "username" = 'hotel77'
   AND "passwordPlain" IS NULL;

UPDATE "GuestUser"
   SET "passwordPlain" = 'vnm123'
 WHERE "username" = 'vnm'
   AND "passwordPlain" IS NULL;
