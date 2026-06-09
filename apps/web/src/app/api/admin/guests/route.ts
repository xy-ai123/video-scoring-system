import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createGuest } from "@/lib/guestUser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/guests
 *
 * Admin-only — create a new per-main guest account.
 * Body: { username, password, allowedMain }
 *
 * Validation lives in lib/guestUser.ts (createGuest throws on any
 * violation). This route is a thin auth gate + zod-parse +
 * try/catch -> appropriate HTTP status.
 */

const BodySchema = z.object({
  // 2-char minimum — see lib/guestUser.ts validateUsername. Keeps
  // schema and lib in sync so the zod rejection message and the
  // lib throw message agree.
  username: z.string().min(2).max(120),
  password: z.string().min(6).max(200),
  allowedMain: z.string().min(1).max(200),
});

function csrfOk(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin) return true; // same-origin fetches without Origin header
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!csrfOk(req)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin")
    return NextResponse.json({ error: "admin_only" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const row = await createGuest(parsed.data);
    return NextResponse.json({ ok: true, guest: row });
  } catch (err) {
    return NextResponse.json(
      {
        error: "validation_error",
        message: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 400 },
    );
  }
}
