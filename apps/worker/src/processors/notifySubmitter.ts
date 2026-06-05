import type { Job } from "bullmq";
import { prisma } from "@vss/db";
import { sendApprovalEmail, sendRejectionEmail } from "../services/email.js";
import {
  appendDecisionRow,
  averageMetric,
} from "../services/sheets.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import type { NotifyJobPayload } from "../lib/queue.js";

export async function processNotifySubmitter(
  job: Job<NotifyJobPayload>,
): Promise<void> {
  const { submissionId, kind = "approval", resend = false } = job.data;
  const log = logger.child({ jobId: job.id, submissionId, kind, resend });

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      scores: { select: { metric: true, value: true } },
    },
  });
  if (!submission) {
    log.warn("submission not found, dropping notify job");
    return;
  }
  if (submission.deletedAt) {
    log.warn(
      { deletedAt: submission.deletedAt },
      "submission is deleted, skipping notify",
    );
    return;
  }
  if (kind === "approval" && submission.status !== "APPROVED") {
    log.warn(
      { status: submission.status },
      "skipping approval notify — submission is no longer APPROVED",
    );
    return;
  }
  if (kind === "rejection" && submission.status !== "REJECTED") {
    log.warn(
      { status: submission.status },
      "skipping rejection notify — submission is no longer REJECTED",
    );
    return;
  }

  // 1. Append the decision row to the configured sheet (best-effort: sheet
  //    write failures shouldn't prevent the email or fail the job, since the
  //    DB already has the source of truth). Skipped on manual resends — the
  //    sheet row was already written on the original approval/rejection.
  if (resend) {
    log.info("resend mode — skipping sheet append");
  } else if (env.SHEET_ID) {
    try {
      const overall = averageMetric(submission.scores, "overall");
      const clarity = averageMetric(submission.scores, "clarity");
      const engagement = averageMetric(submission.scores, "engagement");
      await appendDecisionRow({
        email: submission.submitterEmail,
        category: submission.category,
        status: kind === "approval" ? "APPROVED" : "REJECTED",
        overall,
        clarity,
        engagement,
        submissionId: submission.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          errMessage: message,
          hint: "Verify the sheet is shared with the service account as Editor and that Sheets API is enabled on the GCP project.",
        },
        "sheet append failed (non-fatal — email will still be sent)",
      );
    }
  } else {
    log.info("SHEET_ID not configured, skipping sheet append");
  }

  // 2. Send the email. Throws on failure → BullMQ retries the whole job.
  const payload = {
    to: submission.submitterEmail,
    name: submission.submitterName,
    submissionId: submission.id,
  };
  if (kind === "approval") {
    await sendApprovalEmail(payload);
  } else {
    await sendRejectionEmail(payload);
  }
}
