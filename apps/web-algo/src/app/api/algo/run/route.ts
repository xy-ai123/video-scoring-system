import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentAdmin } from "@/lib/auth";
import { scoreDriveFile } from "@/lib/algoEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ fileId: z.string().min(1) });

export async function POST(req: NextRequest) {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: "invalid-body", message: "fileId is required" },
      { status: 400 },
    );
  }

  const result = await scoreDriveFile(parsed.data.fileId);
  // Always 200 so the dashboard can render the "not configured yet"
  // message inline rather than treating it as a hard error.
  return NextResponse.json(result);
}
