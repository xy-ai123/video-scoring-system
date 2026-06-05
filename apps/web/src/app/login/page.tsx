"use client";

import { LogIn } from "lucide-react";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const errorParam = params.get("error");
  const rawCallback = params.get("callbackUrl") ?? "/admin";
  // Only allow same-origin, path-relative URLs to prevent open redirects.
  const callbackUrl =
    rawCallback.startsWith("/") && !rawCallback.startsWith("//")
      ? rawCallback
      : "/admin";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Three-phase submit state, picked instead of a single `submitting`
  // boolean so the label can tell the user WHAT'S happening:
  //   - "idle":           ready to accept input
  //   - "authenticating": POST /api/login in flight (~100-500ms)
  //   - "navigating":     POST succeeded; waiting for /admin to load
  //                       (in dev mode that's 1-5s of cold compile)
  // Without the "navigating" state the user stares at "Signing in..."
  // for many seconds after the API has actually finished — which feels
  // hung even though it isn't.
  const [phase, setPhase] = useState<"idle" | "authenticating" | "navigating">(
    "idle",
  );
  const submitting = phase !== "idle";
  // Initial error message from URL params:
  //   ?error=invalid_credentials → from /api/login on bad creds
  //   ?error=guest_denied        → from middleware when a guest hits an
  //                                 admin-only route (e.g. /admin/clipping)
  // The latter is informational rather than a "you failed" — it tells the
  // operator they need an admin sign-in to see that page.
  const [error, setError] = useState<string | null>(
    errorParam === "invalid_credentials"
      ? "Wrong username or password."
      : errorParam === "guest_denied"
        ? "That page is admin-only. Sign in as admin, or continue as guest to view submissions."
        : null,
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setPhase("authenticating");
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 401) {
        setError("Wrong username or password.");
        setPhase("idle");
        return;
      }
      if (!res.ok) {
        setError("Login failed. Please try again.");
        setPhase("idle");
        return;
      }
      // POST succeeded; cookie is set. Flip to "navigating" so the
      // button label updates to "Loading dashboard..." while Next.js
      // compiles/loads the destination page. Without this, the user
      // sees "Signing in..." for the full duration of the post-login
      // /admin page load — which in dev mode can be 1-5s of cold
      // compile and feels hung.
      setPhase("navigating");
      // Use Next.js router.replace instead of window.location so HMR's
      // Fast-Refresh "full reload" events (which fire on first-time middleware
      // and route compilation) don't race with and cancel our navigation.
      // `replace` so the login page doesn't sit on the back-button stack.
      router.replace(callbackUrl);
      router.refresh(); // re-fetch server components with the new cookie
    } catch {
      setError("Network error. Please try again.");
      setPhase("idle");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={onSubmit}
        // autoComplete="off" on the form (PLUS the same on each input
        // below) disables Safari/Chrome password-autofill on this page.
        // Why: Safari's autofill races with React state — when the
        // password field gains focus, Safari tries to "synchronize"
        // both fields with a saved credential, and if the saved
        // username is empty/missing it CLEARS the username the user
        // just typed. Disabling autofill keeps the form behaviour
        // deterministic. Trade-off: password managers can't autofill
        // either. For an internal admin tool where the operator types
        // `admin / admin123` (or their own short password) every time,
        // that's fine. Re-enable autoComplete="current-password" if we
        // ever switch to longer passwords + remote operators.
        autoComplete="off"
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm space-y-4"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Video Scoring</h1>
        </div>

        {error ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div>
          <label
            htmlFor="username"
            className="block text-sm font-medium text-slate-700"
          >
            Username
          </label>
          <input
            id="username"
            name="username"
            type="text"
            required
            // Explicit autoComplete="off" overrides any inherited
            // browser heuristic that this is a "login form". Without
            // this, Safari was clearing the typed value when the user
            // focused the password field (autofill trying to sync both
            // fields from a saved credential).
            // autoFocus was also removed — it can race with autofill's
            // focus-tracking when the page first loads.
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-slate-700"
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            // See the comment on the username input. Same reasoning —
            // we explicitly opt out of Safari's password autofill on
            // this page so it can't reach into the username field and
            // overwrite the user's typed value.
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-60"
        >
          <LogIn className="h-4 w-4" />
          {/* Phase-specific labels: "authenticating" is the brief API
              roundtrip, "navigating" is the post-success wait for the
              dashboard to load (the visible long-tail). */}
          {phase === "authenticating"
            ? "Signing in..."
            : phase === "navigating"
              ? "Loading dashboard..."
              : "Sign in"}
        </button>

        {/* Per-main guests sign in via this SAME form with their own
            credentials (e.g. hotel77 / hotel77123). The server's
            /api/login tries the admin table first, then the guest
            table, and issues the right kind of session cookie based
            on which one matches. The previous "Continue as guest"
            anonymous-access button was removed — it bypassed the
            per-main scoping that hotel77/vnm/etc. need. The visible
            help text under the form was removed at the operator's
            request for a cleaner UI; this comment stays so future
            readers know guest-vs-admin lookup is single-form. */}
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
