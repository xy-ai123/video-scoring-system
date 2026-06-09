import { NextRequest, NextResponse } from "next/server";
import { getCurrentAdmin } from "@/lib/auth";
import { getDriveSyncState, startDriveSync } from "@/lib/driveSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/sync-drive
 *   Kicks off a background ingest from every Drive folder the worker
 *   service account has access to. Idempotent — returns 409 if another
 *   sync is already in flight.
 *
 * GET /api/admin/sync-drive
 *   Returns the current sync state (running flag, log tail, parsed
 *   totals once complete). The dashboard polls this every ~2s while
 *   the sync runs so the button can show a live spinner + result count.
 */
export async function POST(req: NextRequest) {
  // CSRF defence — match the per-submission endpoints (approve, reject,
  // score, etc.). SameSite=Lax already protects against most cross-site
  // POSTs but a strict Origin check rules out the rest. Without this,
  // a malicious page could trick a logged-in admin into firing a
  // 3-minute Drive sweep on their behalf.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "bad_origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "bad_origin" }, { status: 403 });
    }
  }
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = startDriveSync();
  if (!result.started) {
    return NextResponse.json(
      { ok: false, reason: result.reason, state: getDriveSyncState() },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, state: getDriveSyncState() });
}

export async function GET() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(getDriveSyncState());
}
