/**
 * Shared Prisma client for the monorepo.
 *
 * The same instance is reused across modules. In dev (with HMR) we cache it
 * on globalThis so every reload doesn't open a new connection pool.
 */

import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __vssPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__vssPrisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "production"
        ? ["error", "warn"]
        : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__vssPrisma = prisma;
}

// Re-export model + enum types so consumers can `import type { Submission, SubmissionStatus, ... } from "@vss/db"`.
// Runtime values like the `Prisma` namespace must still be imported from `@prisma/client` directly to avoid
// CJS-to-ESM re-export issues.
export type {
  PrismaClient,
  Submission,
  VideoFile,
  Score,
  AuditLog,
  SubmissionStatus,
  ScoringStatus,
  Prisma,
} from "@prisma/client";
