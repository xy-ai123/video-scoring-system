import { NextResponse } from "next/server";
import {
  COOKIE_NAME,
  cookieOptions,
  isHttpsRequest,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Defense-in-depth CSRF check. SameSite=Lax handles the common case, but a
  // strict Origin check stops cross-origin POSTs entirely.
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

  const res = NextResponse.json({ ok: true, redirectTo: "/login" });
  // Clear the cookie by setting it with maxAge: 0. Mirror the same `secure`
  // value that login uses so the cookie is matched correctly on the browser
  // side and actually removed.
  const baseOpts = cookieOptions({ isSecureRequest: isHttpsRequest(req) });
  res.cookies.set(COOKIE_NAME, "", { ...baseOpts, maxAge: 0 });
  return res;
}
