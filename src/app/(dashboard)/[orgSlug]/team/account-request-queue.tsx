"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface PendingRequest {
  id: string;
  email: string;
  note: string | null;
  createdAt: string;
}

type Method = "oauth" | "email_password";

/**
 * The queue of people asking to join this org.
 *
 * Approving mints an invitation through the same path an admin-sent invitation
 * uses, so there is one way an account comes into being. The method is chosen
 * PER REQUEST because the right answer differs per person: a colleague who
 * already uses Google wants the sign-in link, someone with no identity provider
 * needs a temporary password.
 *
 * Shown only to ORG_MANAGE_MEMBERS holders, and only rendered when something is
 * actually pending — an empty queue should not add furniture to the page.
 */
export function AccountRequestQueue({
  orgId,
  requests,
}: {
  orgId: string;
  requests: PendingRequest[];
}) {
  const router = useRouter();
  const [method, setMethod] = useState<Record<string, Method>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, action: "approve" | "deny") {
    setBusy(`${id}:${action}`);
    setError(null);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/account-requests/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:
          action === "approve"
            ? JSON.stringify({ signInMethod: method[id] ?? "oauth" })
            : undefined,
      });
      if (!res.ok) {
        // The server's message is the useful one here: it distinguishes
        // "someone else already decided this" (409) from a domain policy that
        // changed since the request was taken (400).
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Reload and try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("That didn't work. Reload and try again.");
    } finally {
      setBusy(null);
    }
  }

  if (requests.length === 0) return null;

  return (
    <section className="mb-6 rounded-lg border border-[var(--border)] p-4">
      <header className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">Account requests</h2>
        <Badge>{requests.length}</Badge>
      </header>

      {error && (
        <p className="mb-3 text-xs text-[var(--status-critical)]" role="alert">
          {error}
        </p>
      )}

      <ul className="space-y-3">
        {requests.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-start justify-between gap-3 border-t border-[var(--border)] pt-3 first:border-0 first:pt-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{r.email}</p>
              {r.note && (
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">{r.note}</p>
              )}
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Asked {new Date(r.createdAt).toLocaleDateString()}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs">
                <span className="sr-only">How {r.email} should sign in</span>
                <select
                  value={method[r.id] ?? "oauth"}
                  onChange={(e) =>
                    setMethod((m) => ({ ...m, [r.id]: e.target.value as Method }))
                  }
                  className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5"
                >
                  <option value="oauth">Invitation link</option>
                  <option value="email_password">Temporary password</option>
                </select>
              </label>
              <Button
                disabled={busy !== null}
                onClick={() => void decide(r.id, "approve")}
              >
                {busy === `${r.id}:approve` ? "Approving…" : "Approve"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void decide(r.id, "deny")}
              >
                {busy === `${r.id}:deny` ? "Denying…" : "Deny"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
