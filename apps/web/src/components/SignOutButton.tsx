"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      // Always navigate, even if the fetch failed; the cookie will eventually
      // expire on its own and the user wants to be on the login page.
      window.location.href = "/login";
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={busy}
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
    >
      <LogOut className="h-3.5 w-3.5" />
      {busy ? "Signing out..." : "Sign out"}
    </button>
  );
}
