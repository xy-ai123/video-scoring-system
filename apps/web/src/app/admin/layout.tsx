import Link from "next/link";
import { redirect } from "next/navigation";
import { PieChart, Scissors, Settings, Smartphone, Users } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { SignOutButton } from "@/components/SignOutButton";
import { SheetsIconLink } from "@/components/SheetsIconLink";

// Never bypass in production, even if AUTH_BYPASS=true leaks into the env.
const BYPASS =
  process.env.AUTH_BYPASS === "true" &&
  process.env.NODE_ENV !== "production";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Local-dev escape hatch: skip the auth check entirely. Treated as admin.
  let displayLabel = "(auth bypassed — dev only)";
  let role: "admin" | "guest" = "admin";

  if (!BYPASS) {
    const session = await getCurrentUser();
    if (!session) redirect("/login");
    role = session.role;
    if (role === "guest") {
      // Guest banner — visually distinct so the operator knows they're
      // in read-only mode without having to remember which button they
      // clicked at /login.
      displayLabel = "Guest (read-only)";
    } else {
      displayLabel = session.username;
    }
  }

  const isAdmin = role === "admin";

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link
            href="/admin"
            className="text-sm font-semibold tracking-tight text-slate-900"
          >
            Video Scoring
          </Link>
          <div className="flex items-center gap-3 text-sm text-slate-600">
            {/* Admin-only links: clipping pipeline, analytics, phone
                inventory, PDF export, Sheets, settings. Guests never see
                these icons — middleware would also block them server-
                side, but hiding the entry point avoids the bad UX of
                clicking something that then redirects to /login. */}
            {isAdmin ? (
              <>
                <Link
                  href="/admin/clipping"
                  aria-label="Clipping pipeline"
                  title="Clipping pipeline (unclipped ↔ clipped)"
                  className="inline-flex items-center rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
                >
                  <Scissors className="h-4 w-4" />
                </Link>
                <Link
                  href="/admin/analytics"
                  aria-label="Analytics — category / PIC pie charts"
                  title="Analytics — category / PIC pie charts"
                  className="inline-flex items-center rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
                >
                  <PieChart className="h-4 w-4" />
                </Link>
                <Link
                  href="/admin/phones"
                  aria-label="Phone inventory"
                  title="Phone inventory"
                  className="inline-flex items-center rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
                >
                  <Smartphone className="h-4 w-4" />
                </Link>
                <Link
                  href="/admin/export"
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
                  title="Export submitter totals as PDF"
                >
                  Export PDF
                </Link>
                <SheetsIconLink />
                <Link
                  href="/admin/guests"
                  aria-label="Guest accounts — create / edit / delete per-main read-only logins"
                  title="Guest accounts (per-main read-only logins)"
                  className="inline-flex items-center rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
                >
                  <Users className="h-4 w-4" />
                </Link>
                <Link
                  href="/admin/settings"
                  aria-label="Account settings — change username/password"
                  title="Account settings"
                  className="inline-flex items-center rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
                >
                  <Settings className="h-4 w-4" />
                </Link>
              </>
            ) : null}
            <span
              className={
                role === "guest"
                  ? "rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200"
                  : ""
              }
            >
              {displayLabel}
            </span>
            {!BYPASS ? <SignOutButton /> : null}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
