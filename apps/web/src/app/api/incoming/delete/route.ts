import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentAdmin } from "@/lib/auth";
import { deleteIncoming } from "@/lib/clipping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  names: z.array(z.string().min(1)).min(1).max(500),
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
  return NextResponse.json(deleteIncoming(parsed.data.names));
}
