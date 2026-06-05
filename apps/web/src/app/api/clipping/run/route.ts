import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentAdmin } from "@/lib/auth";
import { startClippingRun, getRunState } from "@/lib/clipping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  skipPull: z.boolean().optional(),
  skipUpload: z.boolean().optional(),
  folderId: z.string().min(1).optional(),
  selectedFiles: z.array(z.string().min(1)).max(500).optional(),
  // FORM submissions that the user picked via checkbox. Each entry pairs
  // a Drive file ID (for pull_form_submissions to download) with the
  // sanitized filename it'll land at on disk (so detect_hands picks it
  // up via --files).
  selectedForms: z
    .array(
      z.object({
        driveFileId: z.string().min(1),
        fileName: z.string().min(1),
      }),
    )
    .max(500)
    .optional(),
});

export async function POST(req: NextRequest) {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = startClippingRun(parsed.data);
  if (!result.started) {
    return NextResponse.json(
      { ok: false, reason: result.reason, state: getRunState() },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, state: getRunState() });
}

export async function GET() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(getRunState());
}
