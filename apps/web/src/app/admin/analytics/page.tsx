import Link from "next/link";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { getDriveMains } from "@/lib/driveMains";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Analytics page — two pie charts over the same dataset the dashboard
 * shows (non-deleted submissions). One pie groups by Category, the other
 * by Person in Charge (PIC). Null/blank PICs are bucketed as "(no PIC)"
 * so the operator can see how much of the queue is unassigned.
 *
 * Charts are rendered as inline SVG — no chart library dependency, the
 * page typechecks cleanly server-side, and printing-to-PDF would also
 * pick them up.
 */

// Distinct colors that read well together. Cycled mod-length if there are
// more buckets than colors. Order chosen so adjacent slices are visually
// separable.
const COLORS = [
  "#6366f1", // indigo-500
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#ef4444", // red-500
  "#06b6d4", // cyan-500
  "#d946ef", // fuchsia-500
  "#0ea5e9", // sky-500
  "#84cc16", // lime-500
  "#f97316", // orange-500
  "#8b5cf6", // violet-500
  "#14b8a6", // teal-500
  "#ec4899", // pink-500
];

type Bucket = { label: string; count: number; color: string };

function bucketize(
  rows: Array<{ key: string | null }>,
  unknownLabel: string,
): Bucket[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.key && r.key.trim().length > 0 ? r.key : unknownLabel;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Sort descending by count so the biggest slice starts at the top.
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, count], i) => ({
      label,
      count,
      color: COLORS[i % COLORS.length]!,
    }));
}

// Compute SVG arc path for a slice from `startAngle` to `endAngle`,
// expressed in radians where 0 is straight up. Centered at (120, 120),
// radius 100. Edge cases:
//   - Single slice covering the full circle → return null and the caller
//     renders a `<circle>` instead (an arc from 0→2π has start==end and
//     SVG would draw nothing).
function arcPath(startAngle: number, endAngle: number): string | null {
  const cx = 120;
  const cy = 120;
  const r = 100;
  const sweep = endAngle - startAngle;
  if (sweep >= Math.PI * 2 - 0.0001) return null;
  const startX = cx + r * Math.sin(startAngle);
  const startY = cy - r * Math.cos(startAngle);
  const endX = cx + r * Math.sin(endAngle);
  const endY = cy - r * Math.cos(endAngle);
  const largeArc = sweep > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${startX.toFixed(3)} ${startY.toFixed(3)} A ${r} ${r} 0 ${largeArc} 1 ${endX.toFixed(3)} ${endY.toFixed(3)} Z`;
}

function PieChart({
  buckets,
  total,
  emptyMessage,
}: {
  buckets: Bucket[];
  total: number;
  emptyMessage: string;
}) {
  if (total === 0) {
    return (
      <div className="flex h-60 items-center justify-center rounded-md bg-slate-50 text-sm text-slate-400">
        {emptyMessage}
      </div>
    );
  }

  let cursor = 0;
  const slices = buckets.map((b) => {
    const sweep = (b.count / total) * Math.PI * 2;
    const startAngle = cursor;
    const endAngle = cursor + sweep;
    cursor = endAngle;
    return {
      ...b,
      pct: (b.count / total) * 100,
      path: arcPath(startAngle, endAngle),
    };
  });

  // Detect the "everything in one bucket" case → render a single circle.
  const allInOne = buckets.length === 1;

  return (
    <svg
      viewBox="0 0 240 240"
      className="mx-auto h-60 w-60"
      role="img"
      aria-label="Pie chart"
    >
      {allInOne ? (
        <circle cx={120} cy={120} r={100} fill={buckets[0]!.color} />
      ) : (
        slices.map((s, i) =>
          s.path ? (
            <path
              key={i}
              d={s.path}
              fill={s.color}
              stroke="white"
              strokeWidth={2}
            >
              <title>
                {s.label}: {s.count} ({s.pct.toFixed(1)}%)
              </title>
            </path>
          ) : null,
        )
      )}
    </svg>
  );
}

function Legend({ buckets, total }: { buckets: Bucket[]; total: number }) {
  if (total === 0) return null;
  return (
    <ul className="mt-4 space-y-1.5 text-sm">
      {buckets.map((b) => {
        const pct = (b.count / total) * 100;
        return (
          <li
            key={b.label}
            className="flex items-center justify-between gap-3"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 shrink-0 rounded-sm"
                style={{ backgroundColor: b.color }}
              />
              <span className="truncate text-slate-700" title={b.label}>
                {b.label}
              </span>
            </span>
            <span className="shrink-0 text-xs text-slate-500 tabular-nums">
              {b.count}
              {" · "}
              <span className="font-medium text-slate-700">
                {pct.toFixed(1)}%
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default async function AnalyticsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }

  // Same scope the dashboard uses: non-deleted submissions only.
  // Pull files too so the Phone-Provided bucket can fall back to the
  // latest file's name when phoneProvided/driveFolderName/category are
  // all empty — same chain the dashboard's PhoneProvidedCell uses.
  // Mains are fetched in parallel — the dump-script call is the
  // slowest thing on this page (one Drive folder walk), so giving it
  // its own Promise.all slot keeps the cold path snappy.
  const [rows, mains] = await Promise.all([
    prisma.submission.findMany({
      where: { deletedAt: null },
      select: {
        category: true,
        personInCharge: true,
        phoneProvided: true,
        driveFolderName: true,
        files: {
          select: { fileName: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    }),
    getDriveMains(),
  ]);

  // Resolve the top-level Drive main folder per submission. Mirrors
  // /admin/page.tsx exactly so the chart counts match what the
  // dashboard table groups by (Hotel 77, VNM, …) — including the
  // filename-prefix fallback for rows whose immediate parent is a
  // staging or clip-output folder.
  function extractPrefix(s: string | null | undefined): string | null {
    if (!s) return null;
    const noExt = s.replace(/[\\/]/g, "_").replace(/\.[^.]+$/, "");
    const m = noExt.match(/^([A-Za-z0-9]+)(?:[-_]|$)/);
    return m && m[1] ? m[1] : null;
  }
  function resolveMain(
    driveFolderName: string | null,
    fileName: string | null,
  ): string | null {
    if (driveFolderName) {
      const exact = mains.subFolderNameToMain[driveFolderName];
      if (exact) return exact;
      const fp = extractPrefix(driveFolderName);
      if (fp) {
        const via = mains.subFolderNameToMain[fp];
        if (via) return via;
      }
    }
    const filePrefix = extractPrefix(fileName);
    if (filePrefix) {
      const via = mains.subFolderNameToMain[filePrefix];
      if (via) return via;
    }
    return null;
  }
  const mainBuckets = bucketize(
    rows.map((r) => ({
      key: resolveMain(r.driveFolderName, r.files[0]?.fileName ?? null),
    })),
    "(no main)",
  );

  const categoryBuckets = bucketize(
    rows.map((r) => ({ key: r.category })),
    "(none)",
  );
  const picBuckets = bucketize(
    rows.map((r) => ({ key: r.personInCharge })),
    "(no PIC)",
  );
  // Phone Provided bucketing — match the table column's display logic.
  // The cell shows the first non-empty of:
  //   phoneProvided → driveFolderName → category → latestFile.fileName
  //
  // When the displayed value is a driveFolderName with a `_DATE` suffix
  // (e.g. "VPM0167_23MAY" — created by the clip-upload pipeline for
  // a one-day's-worth-of-clips Drive subfolder), strip the suffix so
  // those rows merge into the parent sub bucket ("VPM0167"). Mirrors
  // the dashboard's PhoneProvidedCell + the export page's behaviour
  // so all three views report the same buckets.
  //
  // Falls back to "(none)" for rows where every field is empty (very
  // rare in practice).
  const phoneBuckets = bucketize(
    rows.map((r) => {
      const latest = r.files[0]?.fileName ?? null;
      const phone = r.phoneProvided && r.phoneProvided.trim();
      if (phone) return { key: phone };
      const folder = r.driveFolderName && r.driveFolderName.trim();
      if (folder) {
        const idx = folder.indexOf("_");
        return { key: idx > 0 ? folder.slice(0, idx) : folder };
      }
      const cat = r.category && r.category.trim();
      if (cat) return { key: cat };
      const fname = latest && latest.trim();
      if (fname) return { key: fname };
      return { key: null };
    }),
    "(none)",
  );

  const total = rows.length;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin"
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          ← Back to submissions
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Analytics
        </h1>
        <p className="text-sm text-slate-500">
          Breakdown of the {total}{" "}
          {total === 1 ? "submission" : "submissions"} currently on the
          dashboard (deleted ones excluded).
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* By Main goes first as the most-aggregated view — gives the
            operator a "where is the work going" overview before the
            finer-grained Category / PIC / Phone-Provided breakdowns.
            Spans both columns so the legend has room for project
            names like "Hotel 77" without truncating. */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-2">
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              By Main
            </h2>
            <span className="text-xs text-slate-500">
              {mainBuckets.length}{" "}
              {mainBuckets.length === 1 ? "bucket" : "buckets"}
            </span>
          </header>
          <p className="mb-3 text-xs text-slate-500">
            Top-level Drive folder each submission's source video lives
            under, resolved by walking up Drive's folder graph. Same
            grouping the dashboard's <em>Main</em> column shows. Rows
            without a resolvable top-level folder fall into{" "}
            <code className="rounded bg-slate-100 px-1 text-[11px]">(no main)</code>.
          </p>
          <PieChart
            buckets={mainBuckets}
            total={total}
            emptyMessage="No submissions yet."
          />
          <Legend buckets={mainBuckets} total={total} />
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              By Category
            </h2>
            <span className="text-xs text-slate-500">
              {categoryBuckets.length}{" "}
              {categoryBuckets.length === 1 ? "category" : "categories"}
            </span>
          </header>
          <PieChart
            buckets={categoryBuckets}
            total={total}
            emptyMessage="No submissions yet."
          />
          <Legend buckets={categoryBuckets} total={total} />
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              By Person in Charge
            </h2>
            <span className="text-xs text-slate-500">
              {picBuckets.length}{" "}
              {picBuckets.length === 1 ? "bucket" : "buckets"}
            </span>
          </header>
          <PieChart
            buckets={picBuckets}
            total={total}
            emptyMessage="No submissions yet."
          />
          <Legend buckets={picBuckets} total={total} />
        </section>

        {/* Spans the full row so the legend (which can grow tall for
            folder-id-heavy datasets) has space. */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-2">
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              By Phone Provided
            </h2>
            <span className="text-xs text-slate-500">
              {phoneBuckets.length}{" "}
              {phoneBuckets.length === 1 ? "bucket" : "buckets"}
            </span>
          </header>
          <p className="mb-3 text-xs text-slate-500">
            Same value the dashboard's <em>Phone Provided</em> column
            shows — the form's phone field if collected, otherwise the
            Drive folder name (e.g. <code className="rounded bg-slate-100 px-1 text-[11px]">VPM0166-24_25MAY</code>),
            then category, then the latest file name.
          </p>
          <PieChart
            buckets={phoneBuckets}
            total={total}
            emptyMessage="No submissions yet."
          />
          <Legend buckets={phoneBuckets} total={total} />
        </section>
      </div>
    </div>
  );
}
