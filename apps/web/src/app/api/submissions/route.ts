import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, type SubmissionStatus } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  status: z
    .enum([
      "PENDING",
      "SCORING",
      "SCORED",
      "APPROVED",
      "REJECTED",
      "FAILED",
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: NextRequest) {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = QuerySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid query", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { status, page, pageSize } = parsed.data;

  const where = status ? { status: status as SubmissionStatus } : {};

  const [items, total] = await Promise.all([
    prisma.submission.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { files: true } } },
    }),
    prisma.submission.count({ where }),
  ]);

  return NextResponse.json({
    page,
    pageSize,
    total,
    items: items.map((s) => ({
      id: s.id,
      responseId: s.responseId,
      submitterEmail: s.submitterEmail,
      submitterName: s.submitterName,
      category: s.category,
      status: s.status,
      createdAt: s.createdAt,
      fileCount: s._count.files,
    })),
  });
}
