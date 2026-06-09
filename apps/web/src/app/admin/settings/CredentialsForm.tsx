"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";

/**
 * Form for changing admin username + password. Talks to
 * /api/admin/credentials. Re-authenticates with the current password
 * on every save (server enforces this — we just collect + send it).
 *
 * UX rules:
 *   - newUsername is optional (only sent if different from current)
 *   - newPassword is optional (only sent if non-empty)
 *   - confirmPassword must match newPassword (client-side check first)
 *   - all three boxes are independent — user can change just username,
 *     just password, or both in one save
 */
export function CredentialsForm({
  currentUsername,
  currentPasswordPlain,
}: {
  currentUsername: string;
  /** Plaintext mirror of the admin's current password. Null only on
   *  legacy rows whose plaintext wasn't recoverable — the panel shows
   *  "—" in that case until the admin saves a new password once. See
   *  schema.prisma's AdminUser.passwordPlain comment. */
  currentPasswordPlain: string | null;
}) {
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newUsername, setNewUsername] = useState(currentUsername);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setError(null);
    setSuccess(null);

    // Build the diff: only include fields that actually changed.
    const usernameChanged =
      newUsername.trim().toLowerCase() !== currentUsername.trim().toLowerCase();
    const passwordChanged = newPassword.length > 0;

    if (!usernameChanged && !passwordChanged) {
      setError("Nothing to save — change the username or password first.");
      return;
    }
    if (passwordChanged && newPassword !== confirmPassword) {
      setError("New password and confirmation don't match.");
      return;
    }
    if (passwordChanged && newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (!currentPassword) {
      setError("Type your current password to confirm the change.");
      return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, string> = { currentPassword };
      if (usernameChanged) body.newUsername = newUsername.trim().toLowerCase();
      if (passwordChanged) body.newPassword = newPassword;

      const res = await fetch("/api/admin/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          data?.message ||
          (data?.error === "wrong_password"
            ? "Current password is incorrect."
            : data?.error === "validation_error"
              ? "Validation error."
              : "Save failed.");
        setError(msg);
        setSubmitting(false);
        return;
      }
      setSuccess(
        usernameChanged && passwordChanged
          ? "Username and password updated."
          : usernameChanged
            ? "Username updated."
            : "Password updated.",
      );
      // Clear the password boxes — leaving them filled is a tiny risk
      // if the operator walks away from a shared screen.
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // Soft-refresh the layout so the header + greeting pick up the
      // new username via the re-issued session cookie.
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="max-w-md space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      {error ? (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {success}
        </div>
      ) : null}

      {/* Current-credentials panel (option A — plaintext always visible).
          Mirrors the /admin/guests "Password" column for the admin row,
          so the operator can see what their current password is without
          having to reset it. Null plaintext shows "—" (legacy rows). */}
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium text-slate-700">Current username</span>
          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[12px] text-slate-800 ring-1 ring-slate-200">
            {currentUsername}
          </code>
        </div>
        <div className="mt-1.5 flex items-baseline justify-between gap-3">
          <span className="font-medium text-slate-700">Current password</span>
          {currentPasswordPlain ? (
            <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[12px] text-slate-800 ring-1 ring-slate-200">
              {currentPasswordPlain}
            </code>
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </div>
      </div>

      <div>
        <label
          htmlFor="newUsername"
          className="block text-sm font-medium text-slate-700"
        >
          Username
        </label>
        <input
          id="newUsername"
          name="newUsername"
          type="text"
          autoComplete="username"
          value={newUsername}
          onChange={(e) => setNewUsername(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
        />
        <p className="mt-1 text-[11px] text-slate-500">
          2–120 chars. Lowercase letters, digits, and{" "}
          <code className="rounded bg-slate-100 px-1">. _ -</code> only.
        </p>
      </div>

      <div>
        <label
          htmlFor="newPassword"
          className="block text-sm font-medium text-slate-700"
        >
          New password
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          placeholder="Leave blank to keep current password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
        />
        <p className="mt-1 text-[11px] text-slate-500">
          At least 8 characters. Leave blank to keep the current password.
        </p>
      </div>

      <div>
        <label
          htmlFor="confirmPassword"
          className="block text-sm font-medium text-slate-700"
        >
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
        />
      </div>

      <div className="border-t border-slate-200 pt-4">
        <label
          htmlFor="currentPassword"
          className="block text-sm font-medium text-slate-700"
        >
          Current password
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
        />
        <p className="mt-1 text-[11px] text-slate-500">
          Required to confirm this change — even if a session cookie is
          stolen, the attacker can&apos;t lock you out without knowing
          your current password.
        </p>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-60"
      >
        <Save className="h-4 w-4" />
        {submitting ? "Saving..." : "Save changes"}
      </button>
    </form>
  );
}
