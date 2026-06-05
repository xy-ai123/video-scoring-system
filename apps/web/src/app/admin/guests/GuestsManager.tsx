"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Save, Trash2, X } from "lucide-react";

/**
 * Admin CRUD UI for the GuestUser table.
 *
 * Two modes per row:
 *   - view mode (default): username, allowedMain badge, Edit / Delete
 *     buttons.
 *   - edit mode: text inputs for username + allowedMain + (optional)
 *     new password; Save / Cancel buttons.
 *
 * A "Create new guest" form sits above the table. Both forms POST to
 * /api/admin/guests* and call router.refresh() to re-render with the
 * fresh data from the server.
 */

export type GuestRow = {
  id: string;
  username: string;
  allowedMain: string;
  /** Plaintext password. Null on legacy rows whose plaintext we couldn't
   *  backfill — the UI shows "—" in that case until the admin saves a
   *  fresh password for them once. */
  passwordPlain: string | null;
  updatedAt: string;
};

export function GuestsManager({
  initialGuests,
  knownMains,
}: {
  initialGuests: GuestRow[];
  knownMains: string[];
}) {
  const router = useRouter();

  // ────────────── Create form state ──────────────
  const [createUsername, setCreateUsername] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createMain, setCreateMain] = useState(knownMains[0] ?? "");
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // ────────────── Edit form state (one row at a time) ──────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editAllowedMain, setEditAllowedMain] = useState("");
  const [editNewPassword, setEditNewPassword] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);

  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);

  // Shared success banner for any mutation. Auto-fades via React's
  // unmount; not strictly auto-dismissed, but small + non-blocking.
  const [success, setSuccess] = useState<string | null>(null);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (createBusy) return;
    setCreateErr(null);
    setSuccess(null);
    if (!createUsername.trim()) {
      setCreateErr("Username is required.");
      return;
    }
    if (createPassword.length < 6) {
      setCreateErr("Password must be at least 6 characters.");
      return;
    }
    if (!createMain.trim()) {
      setCreateErr("Allowed main is required.");
      return;
    }
    setCreateBusy(true);
    try {
      const res = await fetch("/api/admin/guests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: createUsername.trim().toLowerCase(),
          password: createPassword,
          allowedMain: createMain.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateErr(data?.message ?? "Couldn't create guest.");
        setCreateBusy(false);
        return;
      }
      setSuccess(`Guest "${createUsername.trim().toLowerCase()}" created.`);
      setCreateUsername("");
      setCreatePassword("");
      router.refresh();
    } catch {
      setCreateErr("Network error.");
    } finally {
      setCreateBusy(false);
    }
  }

  function startEdit(g: GuestRow) {
    setEditingId(g.id);
    setEditUsername(g.username);
    setEditAllowedMain(g.allowedMain);
    setEditNewPassword("");
    setEditErr(null);
  }
  function cancelEdit() {
    setEditingId(null);
    setEditUsername("");
    setEditAllowedMain("");
    setEditNewPassword("");
    setEditErr(null);
  }

  async function onSaveEdit(g: GuestRow) {
    if (editBusy) return;
    setEditErr(null);
    setSuccess(null);
    setEditBusy(true);
    try {
      const body: Record<string, string> = {};
      const newUsername = editUsername.trim().toLowerCase();
      if (newUsername !== g.username) body.newUsername = newUsername;
      if (editAllowedMain.trim() !== g.allowedMain)
        body.newAllowedMain = editAllowedMain.trim();
      if (editNewPassword.length > 0) {
        if (editNewPassword.length < 6) {
          setEditErr("Password must be at least 6 characters.");
          setEditBusy(false);
          return;
        }
        body.newPassword = editNewPassword;
      }
      if (Object.keys(body).length === 0) {
        cancelEdit();
        setEditBusy(false);
        return;
      }
      const res = await fetch(`/api/admin/guests/${g.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditErr(data?.message ?? "Couldn't save changes.");
        setEditBusy(false);
        return;
      }
      setSuccess(`Guest "${g.username}" updated.`);
      cancelEdit();
      router.refresh();
    } catch {
      setEditErr("Network error.");
    } finally {
      setEditBusy(false);
    }
  }

  async function onDelete(g: GuestRow) {
    if (deleteBusyId) return;
    const ok = window.confirm(
      `Delete guest "${g.username}"? This can't be undone (you can re-create them with the same name later).`,
    );
    if (!ok) return;
    setDeleteBusyId(g.id);
    setSuccess(null);
    try {
      const res = await fetch(`/api/admin/guests/${g.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        window.alert(data?.message ?? "Couldn't delete guest.");
        return;
      }
      setSuccess(`Guest "${g.username}" deleted.`);
      router.refresh();
    } finally {
      setDeleteBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      {success ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {success}
        </div>
      ) : null}

      {/* ───────── Create form ───────── */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Add a new guest account
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Pick the Drive main this guest can view. They&apos;ll be able to see
          submissions inside that main only.
        </p>
        {createErr ? (
          <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {createErr}
          </div>
        ) : null}
        <form
          onSubmit={onCreate}
          className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4"
        >
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Username
            </label>
            <input
              type="text"
              value={createUsername}
              onChange={(e) => setCreateUsername(e.target.value)}
              placeholder="e.g. hotel77"
              autoComplete="off"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Password
            </label>
            <input
              type="text"
              value={createPassword}
              onChange={(e) => setCreatePassword(e.target.value)}
              placeholder="≥6 chars, e.g. hotel77123"
              autoComplete="off"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Allowed main
            </label>
            {/* Free-text input bound to a datalist of known mains. Best
                of both: admin can pick from existing mains in one
                click, OR type a brand-new value for a Drive folder
                that exists but hasn't been ingested yet. */}
            <input
              type="text"
              list="known-mains"
              value={createMain}
              onChange={(e) => setCreateMain(e.target.value)}
              placeholder="e.g. Hotel 77"
              autoComplete="off"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
            />
            <datalist id="known-mains">
              {knownMains.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={createBusy}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
              {createBusy ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </section>

      {/* ───────── Guest table ───────── */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Username</th>
              <th className="px-4 py-2.5">Password</th>
              <th className="px-4 py-2.5">Allowed main</th>
              <th className="px-4 py-2.5">Last changed</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {initialGuests.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-6 text-center text-sm text-slate-500"
                >
                  No guest accounts yet. Create one above.
                </td>
              </tr>
            ) : null}
            {initialGuests.map((g) => {
              const isEditing = editingId === g.id;
              return (
                <tr key={g.id}>
                  {isEditing ? (
                    <>
                      <td className="px-4 py-2">
                        <input
                          type="text"
                          value={editUsername}
                          onChange={(e) => setEditUsername(e.target.value)}
                          autoComplete="off"
                          className="block w-full rounded-md border border-slate-300 px-2 py-1 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
                        />
                      </td>
                      <td className="px-4 py-2">
                        {/* Show the CURRENT password as a hint above the
                            "new password" input so the admin can see what
                            it is now while typing a replacement. Blank
                            input means "leave it unchanged". */}
                        {g.passwordPlain ? (
                          <div className="mb-1 text-[11px] text-slate-500">
                            Current:{" "}
                            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-slate-700">
                              {g.passwordPlain}
                            </code>
                          </div>
                        ) : (
                          <div className="mb-1 text-[11px] text-slate-400">
                            Current: —
                          </div>
                        )}
                        <input
                          type="text"
                          value={editNewPassword}
                          onChange={(e) => setEditNewPassword(e.target.value)}
                          placeholder="New password (blank = keep)"
                          autoComplete="off"
                          className="block w-full rounded-md border border-slate-300 px-2 py-1 text-xs shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="text"
                          list="known-mains"
                          value={editAllowedMain}
                          onChange={(e) => setEditAllowedMain(e.target.value)}
                          autoComplete="off"
                          className="block w-full rounded-md border border-slate-300 px-2 py-1 text-sm shadow-sm focus:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-700"
                        />
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-400">—</td>
                      <td className="px-4 py-2 text-right">
                        {editErr ? (
                          <div className="mb-1 text-[11px] text-red-700">
                            {editErr}
                          </div>
                        ) : null}
                        <div className="inline-flex gap-1">
                          <button
                            type="button"
                            onClick={() => onSaveEdit(g)}
                            disabled={editBusy}
                            className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-60"
                          >
                            <Save className="h-3.5 w-3.5" />
                            {editBusy ? "Saving..." : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            disabled={editBusy}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                          >
                            <X className="h-3.5 w-3.5" />
                            Cancel
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-2 font-medium text-slate-900">
                        {g.username}
                      </td>
                      <td className="px-4 py-2">
                        {/* Plaintext password (option A — always visible).
                            Null on rows pre-dating this column whose
                            plaintext we couldn't recover; show "—" then. */}
                        {g.passwordPlain ? (
                          <code className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-800">
                            {g.passwordPlain}
                          </code>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                          {g.allowedMain}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-400">
                        {new Date(g.updatedAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="inline-flex gap-1">
                          <button
                            type="button"
                            onClick={() => startEdit(g)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(g)}
                            disabled={deleteBusyId === g.id}
                            className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {deleteBusyId === g.id ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
