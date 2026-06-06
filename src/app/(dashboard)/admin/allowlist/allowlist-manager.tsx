"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { jsonFetch } from "@/lib/query/json-fetcher";

type Entry = {
  id: string;
  email: string;
  addedBy: string | null;
  addedByName: string | null;
  createdAt: string;
};

const QUERY_KEY = ["admin", "allowed-emails"] as const;

export function AllowlistManager() {
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState<Entry | null>(null);

  // Cache is warmed server-side via HydrationBoundary in the parent page.
  // First render reads prefetched data — no loading flash.
  const { data: entries = [] } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => jsonFetch<Entry[]>("/api/v1/admin/allowed-emails"),
  });

  const addMutation = useMutation({
    mutationFn: (payload: { email: string }) =>
      jsonFetch<Entry>("/api/v1/admin/allowed-emails", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (created) => {
      qc.setQueryData<Entry[]>(QUERY_KEY, (curr = []) => [created, ...curr]);
      setEmail("");
      startTransition(() => router.refresh());
    },
    onError: (e: Error) => setError(e.message),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) =>
      jsonFetch<unknown>(`/api/v1/admin/allowed-emails/${id}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, id) => {
      qc.setQueryData<Entry[]>(QUERY_KEY, (curr = []) =>
        curr.filter((e) => e.id !== id),
      );
      startTransition(() => router.refresh());
    },
    onError: (e: Error) => setError(e.message),
  });

  const pending = addMutation.isPending || removeMutation.isPending;

  function add() {
    setError(null);
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    addMutation.mutate({ email: trimmed });
  }

  function remove(entry: Entry) {
    setConfirmRemove(entry);
  }

  function confirmAndRemove() {
    if (!confirmRemove) return;
    setError(null);
    removeMutation.mutate(confirmRemove.id);
    setConfirmRemove(null);
  }

  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          type="email"
          placeholder="user@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          aria-label="Email to allow"
        />
        <Button type="submit" disabled={pending}>
          Add
        </Button>
      </form>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      <div className="rounded-md border">
        {entries.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No emails on the allowlist yet.
          </p>
        ) : (
          <ul className="divide-y">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between px-4 py-3"
              >
                <div>
                  <p className="font-mono text-sm">{entry.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {(entry.addedByName || entry.addedBy) ? `Added by ${entry.addedByName || entry.addedBy} · ` : ""}
                    {new Date(entry.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(entry)}
                  disabled={pending}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog
        open={!!confirmRemove}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove from allowlist</DialogTitle>
            <DialogDescription>
              Remove {confirmRemove?.email} from the allowlist? This user will no
              longer be able to sign in.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmAndRemove}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
