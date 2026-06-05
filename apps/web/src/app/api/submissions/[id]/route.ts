import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    include: {
      files: {
        select: {
          id: true,
          driveFileId: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          scoringStatus: true,
          scoringError: true,
          processedAt: true,
          createdAt: true,
          // NOTE: deliberately NOT including `scores.raw` — that's the full
          // algorithm-engine response and could contain debug stack traces,
          // internal URLs, or other server-side metadata that shouldn't leak.
          scores: {
            select: { id: true, metric: true, value: true, createdAt: true },
          },
        },
      },
      scores: {
        select: { id: true, metric: true, value: true, fileId: true, createdAt: true },
      },
    },
  });
  if (!submission) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Whitelist the top-level fields too — never spread the whole row, so future
  // schema additions don't auto-leak. BigInt -> string for JSON-safety.
  return NextResponse.json({
    id: submission.id,
    responseId: submission.responseId,
    submitterEmail: submission.submitterEmail,
    submitterName: submission.submitterName,
    category: submission.category,
    status: submission.status,
    notes: submission.notes,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
    reviewedAt: submission.reviewedAt,
    reviewedBy: submission.reviewedBy,
    deletedAt: submission.deletedAt,
    deletedBy: submission.deletedBy,
    files: submission.files.map((f) => ({
      ...f,
      sizeBytes: f.sizeBytes != null ? f.sizeBytes.toString() : null,
    })),
    scores: submission.scores,
  });
}
