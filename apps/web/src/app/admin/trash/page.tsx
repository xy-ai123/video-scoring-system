import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@vss/db";
import { TrashTable, type TrashRow } from "@/components/TrashTable";
import { getCurrentAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function TrashPage() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }
  const submissions = await prisma.submission.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    take: 200,
    include: { _count: { select: { files: true } } },
  });

  const rows: TrashRow[] = submissions.map((s) => ({
    id: s.id,
    submitterEmail: s.submitterEmail,
    submitterName: s.submitterName,
    category: s.category,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    // Non-null because we filtered for `deletedAt: { not: null }`. Cast for TS.
    deletedAt: (s.deletedAt as Date).toISOString(),
    deletedBy: s.deletedBy,
    fileCount: s._count.files,
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to submissions
        </Link>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Deleted Submissions
          </h1>
          <p className="text-sm text-slate-500">
            Submissions you&apos;ve deleted. They&apos;re not removed from the
            database — click Restore to bring one back.
          </p>
        </div>
        <div className="text-sm text-slate-500">
          {rows.length} deleted submission{rows.length === 1 ? "" : "s"}
        </div>
      </div>

      <TrashTable rows={rows} />
    </div>
  );
}
