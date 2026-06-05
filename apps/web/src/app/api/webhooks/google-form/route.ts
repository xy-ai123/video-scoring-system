import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@vss/db";
import { verifyHmac } from "@/lib/hmac";
import { enqueueScoreJobs } from "@/lib/queue";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PayloadSchema = z.object({
  responseId: z.string().min(1),
  submitterEmail: z.string().email(),
  submitterName: z.string().min(1),
  category: z.string().min(1),
  // Optional. Apps Script sends this when the form has a "Phone Provided"
  // question and FIELD_PHONE is configured. Older Apps Script deployments
  // simply omit the key.
  phoneProvided: z.string().max(60).optional(),
  files: z
    .array(
      z.object({
        driveFileId: z.string().min(1),
        name: z.string().min(1),
        mimeType: z.string().optional(),
      }),
    )
    .min(1),
});

export async function POST(req: NextRequest) {
  // Cap body size BEFORE buffering — anyone can hit this endpoint, HMAC alone
  // doesn't protect against large-body DoS.
  const MAX_BODY_BYTES = 64 * 1024;
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  // 1. Verify HMAC. This is the only auth on this endpoint.
  // Optional replay protection: if X-Timestamp is present, verify it is within
  // ±5 minutes of server time and sign over `${timestamp}\n${rawBody}`.
  // Falls back to signing over just rawBody when the header is absent for
  // backwards-compatibility with older Apps Script versions.
  const signature = req.headers.get("x-signature");
  const tsHeader = req.headers.get("x-timestamp");
  let signingPayload = rawBody;
  if (tsHeader) {
    const ts = Number(tsHeader);
    const drift = Math.abs(Date.now() - ts);
    if (!Number.isFinite(ts) || drift > 5 * 60 * 1000) {
      return NextResponse.json({ error: "stale timestamp" }, { status: 401 });
    }
    signingPayload = `${tsHeader}\n${rawBody}`;
  }
  const ok = verifyHmac(signingPayload, signature, env.WEBHOOK_SECRET);
  if (!ok) {
    logger.warn(
      { hasSignature: Boolean(signature) },
      "webhook signature mismatch",
    );
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // 2. Parse + validate JSON.
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = PayloadSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({ err: parsed.error.flatten() }, "webhook payload invalid");
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }
  const payload = parsed.data;

  try {
    // 3. Idempotent upsert by responseId. If existing, return early.
    const existing = await prisma.submission.findUnique({
      where: { responseId: payload.responseId },
      select: { id: true },
    });

    if (existing) {
      logger.info(
        { submissionId: existing.id, responseId: payload.responseId },
        "duplicate webhook ignored",
      );
      return NextResponse.json({ status: "duplicate", submissionId: existing.id });
    }

    const submission = await prisma.submission.create({
      data: {
        responseId: payload.responseId,
        submitterEmail: payload.submitterEmail.toLowerCase(),
        submitterName: payload.submitterName,
        // Empty string from Apps Script -> null in the DB, mirroring the
        // notes / PIC routes' "no whitespace-only values" convention.
        phoneProvided: payload.phoneProvided?.trim()
          ? payload.phoneProvided.trim()
          : null,
        category: payload.category,
        status: "PENDING",
        files: {
          create: payload.files.map((f) => ({
            driveFileId: f.driveFileId,
            fileName: f.name,
            mimeType: f.mimeType ?? null,
          })),
        },
      },
      select: { id: true },
    });

    // 4. Enqueue scoring. Don't block too long if Redis is sluggish.
    const enqueued = await enqueueScoreJobs(submission.id);

    logger.info(
      {
        submissionId: submission.id,
        responseId: payload.responseId,
        enqueued,
        // Diagnostic: makes it obvious in the dev log whether Apps Script
        // is sending the new phoneProvided field. Use this to tell apart
        // "Apps Script sent it but DB rejected it" vs. "Apps Script never
        // sent it" without having to add ad-hoc logging.
        phoneProvidedReceived: payload.phoneProvided != null,
        phoneProvidedValue: payload.phoneProvided ?? null,
      },
      "submission accepted",
    );

    return NextResponse.json({
      status: "accepted",
      submissionId: submission.id,
      enqueued,
    });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    // Loud, easy-to-spot log line — the structured one comes next.
    // eslint-disable-next-line no-console
    console.error("[webhook] processing failed:", errMessage);
    logger.error({ err, errMessage }, "webhook processing failed");
    // Returning 200 on internal failure would mask issues; but Apps Script will
    // retry on non-2xx. Per spec we return 200 to Apps Script unless signature
    // fails (401) or payload is invalid (400). Internal errors -> 500 so Apps
    // Script's own retry loop kicks in.
    return NextResponse.json(
      { error: "internal error" },
      { status: 500 },
    );
  }
}
