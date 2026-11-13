"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LocalTimestamp } from "@/components/ui/local-timestamp";
import { jsonFetch } from "@/lib/query/json-fetcher";

type Account = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  orgs: string[];
};

// Instance-wide, not org-scoped, like the other /admin lists.
const QUERY_KEY = ["admin", "sso-provisioned"] as const;
const CARD = "rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5";

/**
 * Accounts marked as made by an organization's single sign-on. The mark keeps
 * them out of platform admin and keeps Google and Microsoft from linking to
 * them by address. When an instance admin knows the person made the account
 * themselves, they clear the mark here; each clear is audited.
 */
export function SsoProvisionedAccounts() {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: accounts, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => jsonFetch<Account[]>("/api/v1/admin/sso-provisioned"),
  });

  const clear = useMutation({
    mutationFn: (id: string) => jsonFetch<unknown>(`/api/v1/admin/sso-provisioned/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => qc.setQueryData<Account[]>(QUERY_KEY, (curr = []) => curr.filter((a) => a.id !== id)),
    onError: (e: Error) => setError(e.message),
  });

  return (
    <section className={CARD} aria-labelledby="sso-provisioned-heading">
      <h3 id="sso-provisioned-heading" className="text-sm font-semibold">
        Accounts made by single sign-on
      </h3>
      <p className="mt-1 max-w-2xl text-xs text-[var(--text-muted)]">
        An organization&apos;s single sign-on made these accounts. They can&apos;t be platform
        admins, and Google or Microsoft won&apos;t sign in to them by email address. If you know
        someone made their account themselves, clear the mark.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-[var(--status-critical-text)]">
          {error}
        </p>
      ) : null}
      <div className="mt-3 rounded-md border border-[var(--border)]">
        {isLoading ? (
          <p className="p-4 text-sm text-[var(--text-muted)]">Loading…</p>
        ) : !accounts || accounts.length === 0 ? (
          <p className="p-4 text-sm text-[var(--text-muted)]">No accounts are marked.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-[var(--text)]">
                    {a.displayName} <span className="font-mono text-xs text-[var(--text-muted)]">{a.email}</span>
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {a.orgs.length > 0 ? `${a.orgs.join(", ")} · ` : ""}
                    Created <LocalTimestamp value={a.createdAt} />
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={clear.isPending}
                  onClick={() => {
                    setError(null);
                    setConfirm(a);
                  }}
                >
                  Clear mark
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear the single sign-on mark</DialogTitle>
            <DialogDescription>
              Clear it only if you know {confirm?.email} made this account themselves. Google and
              Microsoft can then sign in to it by email address, and a listed admin address can
              act as a platform admin. The change goes in the audit log.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirm) clear.mutate(confirm.id);
                setConfirm(null);
              }}
            >
              Clear mark
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
