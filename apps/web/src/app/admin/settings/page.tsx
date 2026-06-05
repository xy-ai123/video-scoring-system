import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { CredentialsForm } from "./CredentialsForm";

export const dynamic = "force-dynamic";

/**
 * Admin-only account-settings page. Lets the signed-in admin change
 * their own username and/or password.
 *
 * Server-side gating: even though `middleware.ts` already redirects
 * non-admin sessions away from /admin/* subpaths, we also check here
 * so a hypothetical bug in the middleware doesn't accidentally leak
 * the settings UI to guests. Defense-in-depth — cheap.
 */
export default async function AdminSettingsPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/login");

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
        <h1 className="text-2xl font-semibold tracking-tight">Account settings</h1>
        <p className="text-sm text-slate-500">
          Change your admin username or password. Currently signed in as{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[12px]">
            {user.username}
          </code>
          .
        </p>
      </div>

      <CredentialsForm currentUsername={user.username} />
    </div>
  );
}
