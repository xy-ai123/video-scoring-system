import Link from "next/link";
import { prisma } from "@vss/db";
import { getCurrentAdmin } from "@/lib/auth";
import { getDriveMains } from "@/lib/driveMains";
import { AddPhoneButton, BulkAddPhonesButton } from "./PhoneFormButtons";
import { PhonesTable, type PhoneTableRow } from "./PhonesTable";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Phone inventory page — kept in lockstep with /admin.
 *
 * Phone ↔ Submission matching mirrors the dashboard's Phone Provided
 * cell. A submission belongs to phone P.internal when any of:
 *
 *   1. submission.phoneProvided  === P.internal        (form submissions)
 *   2. submission.driveFolderName === P.internal       (Drive-ingested raw videos)
 *   3. submission.driveFolderName  starts with         (clip-output subfolders
 *      "<P.internal>_"  e.g. VPM0167_23MAY  → VPM0167)  upload_group_to_drive
 *                                                       creates these per session)
 *
 * For each matched submission we also tag:
 *   - main: top-level Drive folder (Hotel 77, VNM) via getDriveMains()
 *   - clipped: file name contains "(clipped)" (same signal as /admin's Clipped chip)
 *
 * Rolled up per phone so the table shows submission counts, clipped /
 * unclipped split, and the main(s) this phone is being used for.
 */
export default async function PhonesPage() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }

  // Pull every phone in parallel with the cached Drive-main map, so
  // the page's cold path is bounded by the slower of the two (mains
  // is ~3s when the cache is cold, instant otherwise).
  const [phones, mains] = await Promise.all([
    prisma.phone.findMany({ orderBy: { internal: "asc" } }),
    getDriveMains(),
  ]);

  // No phones → render an empty list, skip the whole match pass.
  if (phones.length === 0) {
    return renderShell([]);
  }

  const phoneIds = phones.map((p) => p.internal);

  // One bulk Prisma call covers all three match rules above. Prisma's
  // `OR` short-circuits — index hits on phoneProvided and driveFolderName
  // make this fast even with hundreds of submissions.
  const submissions = await prisma.submission.findMany({
    where: {
      deletedAt: null,
      OR: [
        { phoneProvided: { in: phoneIds } },
        { driveFolderName: { in: phoneIds } },
        // For each phoneId, match driveFolderName === "<id>_…"
        ...phoneIds.map((id) => ({
          driveFolderName: { startsWith: `${id}_` },
        })),
      ],
    },
    select: {
      id: true,
      submitterName: true,
      submitterEmail: true,
      category: true,
      status: true,
      createdAt: true,
      phoneProvided: true,
      driveFolderName: true,
      files: {
        select: { fileName: true, durationSec: true },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Map each submission to its phone internal id via the same fallback
  // chain. Submissions that match multiple phones (shouldn't happen
  // with current data, but defensive) attribute to the first match.
  const phoneIdSet = new Set(phoneIds);
  function resolvePhoneInternal(s: {
    phoneProvided: string | null;
    driveFolderName: string | null;
  }): string | null {
    if (s.phoneProvided && phoneIdSet.has(s.phoneProvided)) {
      return s.phoneProvided;
    }
    const dfn = s.driveFolderName;
    if (!dfn) return null;
    if (phoneIdSet.has(dfn)) return dfn;
    // Strip _<DATE> suffix on clip-output subfolders.
    const idx = dfn.indexOf("_");
    if (idx > 0) {
      const stem = dfn.slice(0, idx);
      if (phoneIdSet.has(stem)) return stem;
    }
    return null;
  }

  // Same filename-prefix fallback the dashboard uses to resolve main
  // when driveFolderName is a clip-output subfolder.
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
    const fp = extractPrefix(fileName);
    if (fp) {
      const via = mains.subFolderNameToMain[fp];
      if (via) return via;
    }
    return null;
  }

  // Bucket per phone, tracking the metrics the table needs.
  type Acc = {
    list: PhoneTableRow["submissions"];
    mains: Set<string>;
    clipped: number;
    unclipped: number;
  };
  const byPhone = new Map<string, Acc>();
  for (const s of submissions) {
    const pid = resolvePhoneInternal(s);
    if (!pid) continue;
    const isClipped = s.files.some((f) => /\(clipped\)/i.test(f.fileName));
    const mainName = resolveMain(
      s.driveFolderName,
      s.files[0]?.fileName ?? null,
    );
    const acc =
      byPhone.get(pid) ??
      ({
        list: [],
        mains: new Set<string>(),
        clipped: 0,
        unclipped: 0,
      } satisfies Acc);
    acc.list.push({
      id: s.id,
      submitterName: s.submitterName,
      submitterEmail: s.submitterEmail,
      category: s.category,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
    });
    if (mainName) acc.mains.add(mainName);
    if (isClipped) acc.clipped += 1;
    else acc.unclipped += 1;
    byPhone.set(pid, acc);
  }

  const rows: PhoneTableRow[] = phones.map((p) => {
    const acc = byPhone.get(p.internal);
    return {
      internal: p.internal,
      modelNumber: p.modelNumber,
      phoneSerial: p.phoneSerial,
      imei: p.imei,
      imei2: p.imei2,
      rentedOut: p.rentedOut,
      rentedAt: p.rentedAt ? p.rentedAt.toISOString() : null,
      assignedUser: p.assignedUser,
      notes: p.notes,
      submissions: acc?.list ?? [],
      main:
        acc && acc.mains.size > 0
          ? Array.from(acc.mains).sort().join(", ")
          : null,
      clippedCount: acc?.clipped ?? 0,
      unclippedCount: acc?.unclipped ?? 0,
    };
  });

  return renderShell(rows);
}

function renderShell(rows: PhoneTableRow[]) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            href="/admin"
            className="text-sm text-slate-500 hover:text-slate-900"
          >
            ← Back to submissions
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Phone inventory
          </h1>
          <p className="text-sm text-slate-500">
            Phones loaned out to participants. Each row links to the
            submissions made with that phone — matched against the
            form&apos;s &quot;Phone Provided&quot; field AND the Drive
            folder name (e.g. <code>VPM0166</code>) so Drive-ingested
            videos line up too.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <BulkAddPhonesButton />
          <AddPhoneButton />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
          No phones yet. Click <span className="font-medium">Add phone</span>{" "}
          to add the first one.
        </div>
      ) : (
        <PhonesTable phones={rows} />
      )}
    </div>
  );
}
