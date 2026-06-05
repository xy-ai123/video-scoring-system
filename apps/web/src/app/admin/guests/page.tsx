import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { listGuests, ensureGuestsSeeded } from "@/lib/guestUser";
import { getDriveMains } from "@/lib/driveMains";
import { GuestsManager } from "./GuestsManager";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Admin-only page: list / create / edit / delete the per-main guest
 * accounts (hotel77, vnm, …). Each row scopes a login to ONE Drive
 * main folder — see lib/guestUser.ts for the schema rationale.
 *
 * Server-side gating: middleware ALREADY blocks /admin/guests for
 * guests (it's not in isGuestAllowedPath), but we also check the
 * role here as defense-in-depth.
 *
 * We feed `knownMains` from getDriveMains() into the client form so
 * the admin can pick the allowedMain from a dropdown of CURRENTLY-
 * known mains. They can still type a custom value (e.g. for a brand
 * new main that hasn't been ingested yet).
 */
export default async function AdminGuestsPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/login");

  // Seed hotel77 + vnm on first ever load of this page so an admin
  // who visits before any login has happened still sees the initial
  // rows in the table. Idempotent — no-op when rows already exist.
  await ensureGuestsSeeded();

  const [guests, mains] = await Promise.all([listGuests(), getDriveMains()]);

  // Strip Date instances to ISO strings so the server-rendered payload
  // doesn't fail the "non-plain-object passed to Client Component" rule.
  // passwordPlain may be null on legacy rows whose plaintext wasn't
  // recoverable — pass through as-is so the UI can render "—" for that
  // case.
  const safeGuests = guests.map((g) => ({
    id: g.id,
    username: g.username,
    allowedMain: g.allowedMain,
    passwordPlain: g.passwordPlain,
    updatedAt: g.updatedAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Submissions
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Guest accounts
        </h1>
        <p className="text-sm text-slate-500">
          Per-main read-only logins. Each guest sees only the submissions
          inside one Drive main folder (e.g.{" "}
          <code className="rounded bg-slate-100 px-1">hotel77</code> →{" "}
          <code className="rounded bg-slate-100 px-1">Hotel 77</code>).
        </p>
      </div>

      <GuestsManager
        initialGuests={safeGuests}
        knownMains={mains.knownMains}
      />
    </div>
  );
}
