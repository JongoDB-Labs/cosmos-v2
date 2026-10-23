"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { API_KEY_SCOPES, API_KEY_SCOPE_LABELS, type ApiKeyScope } from "@/lib/auth/api-key-scopes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { LoadError } from "@/components/ui/load-error";
import { LocalTimestamp } from "@/components/ui/local-timestamp";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TokenRevealDialog } from "./token-reveal-dialog";

interface PersonalToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string;
  lastUsed: string | null;
}

const DAY = 86_400;

/**
 * A member's own API tokens for this organization (`/api/v1/me/tokens`):
 * they act as you, limited to their scopes, and always expire. Org-wide
 * integration keys are an admin's, in Settings → API keys.
 */
export function PersonalTokensPanel({
  orgId,
  orgName,
  maxDays,
}: {
  orgId: string;
  orgName: string;
  /** The org's lifetime cap: 90 days, 30 in a government organization. */
  maxDays: number;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["read"]);
  const [days, setDays] = useState(Math.min(30, maxDays));
  const [minted, setMinted] = useState("");
  const lifetimes = [7, 30, 90].filter((d) => d <= maxDays);

  const queryKey = useOrgQueryKey("me-tokens", orgId);
  const { data: tokens = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<PersonalToken[]>(`/api/v1/me/tokens?orgId=${orgId}`),
  });

  const create = useOrgMutation<{ token: string }, Error, void>({
    mutationFn: () =>
      jsonFetch("/api/v1/me/tokens", {
        method: "POST",
        body: JSON.stringify({ orgId, name: name.trim(), scopes, expiresIn: days * DAY }),
      }),
    invalidate: [["me-tokens", orgId]],
    onSuccess: (data) => {
      setCreateOpen(false);
      setMinted(data?.token ?? "");
    },
    onError: (err) => notifyError(err, "Couldn't create the token."),
  });

  const revoke = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`/api/v1/me/tokens/${id}`, { method: "DELETE" }),
    invalidate: [["me-tokens", orgId]],
    onError: (err) => notifyError(err, "Couldn't revoke the token."),
  });

  function openCreate() {
    setName("");
    setScopes(["read"]);
    setDays(Math.min(30, maxDays));
    setCreateOpen(true);
  }

  return (
    <section className="rounded-lg border border-[var(--border)] p-5" aria-labelledby="personal-tokens-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="personal-tokens-heading" className="text-sm font-semibold text-[var(--text)]">
            Personal access tokens
          </h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Tokens that act as you in {orgName}, for scripts and tools. Each is limited to its scopes and
            expires within {maxDays} days.{" "}
            <Link href="/developers" className="underline hover:text-[var(--text)]">API docs</Link>
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1 h-3.5 w-3.5" /> New token
        </Button>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <p className="text-xs text-[var(--text-muted)]">Loading…</p>
        ) : isError ? (
          <LoadError onRetry={() => refetch()} />
        ) : tokens.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">No personal tokens for this organization.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2.5">
                <KeyRound className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    <code className="font-mono text-[11px] text-[var(--text-muted)]">cosmos_{t.prefix}_…</code>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                    {t.scopes.map((s) => (
                      <Badge key={s} variant="neutral" className="text-[10px]">{s}</Badge>
                    ))}
                    <span>Expires <LocalTimestamp value={t.expiresAt} /></span>
                    <span>· {t.lastUsed ? <>Last used <LocalTimestamp value={t.lastUsed} /></> : "Never used"}</span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Revoke ${t.name}`}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(t.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New personal access token</DialogTitle>
            <DialogDescription>It can do what you can, within the scopes you pick.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pat-name">Token name</Label>
              <Input id="pat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly export" />
            </div>
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Scopes</legend>
              <div className="grid grid-cols-1 gap-1.5">
                {API_KEY_SCOPES.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={scopes.includes(s)}
                      onChange={() => setScopes((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))}
                    />
                    <span>{API_KEY_SCOPE_LABELS[s]}</span>
                    <code className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">{s}</code>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-1.5">
              <Label htmlFor="pat-expiry">Expires in</Label>
              <select
                id="pat-expiry"
                className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {lifetimes.map((d) => (
                  <option key={d} value={d}>{d} days</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              disabled={!name.trim() || scopes.length === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Create token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TokenRevealDialog token={minted} title="Token created" onClose={() => setMinted("")} />
    </section>
  );
}
