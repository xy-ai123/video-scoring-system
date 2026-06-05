import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { deleteGuest, updateGuest } from "@/lib/guestUser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/guests/[id]   — update one or more fields on a guest row
 * DELETE /api/admin/guests/[id]  — hard-delete a guest row
 *
 * Both admin-only. PATCH body fields are all optional:
 *   - newUsername?    (3-120 chars, lowercase alphanumeric + . _ -)
 *   - newPassword?    (≥6 chars)
 *   - newAllowedMain? (1-200 chars; admin picks from getDriveMains in the UI)
 * Omit fields you don't want to change.
 */

const PatchSchema = z.object({
  newUsername: z.string().min(3).max(120).optional(),
  newPassword: z.string().min(6).max(200).optional(),
  newAllowedMain: z.string().min(1).max(200).optional(),
});

function csrfOk(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) {
    return {
      err: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  if (user.role !== "admin") {
    return {
      err: NextResponse.json({ error: "admin_only" }, { status: 403 }),
    };
  }
  return { user };
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  if (!csrfOk(req))
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const auth = await requireAdmin();
  if ("err" in auth) return auth.err;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (
    parsed.data.newUsername === undefined &&
    parsed.data.newPassword === undefined &&
    parsed.data.newAllowedMain === undefined
  ) {
    return NextResponse.json(
      {
        error: "no_changes",
        message: "Provide newUsername, newPassword, and/or newAllowedMain.",
      },
      { status: 400 },
    );
  }
  try {
    const row = await updateGuest(params.id, parsed.data);
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

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  if (!csrfOk(req))
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const auth = await requireAdmin();
  if ("err" in auth) return auth.err;

  const removed = await deleteGuest(params.id);
  return NextResponse.json({ ok: true, removed });
}
