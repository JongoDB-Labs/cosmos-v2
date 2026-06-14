"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2,
  Plus,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
  KeyRound,
} from "lucide-react";
import { API_KEY_SCOPES, type ApiKeyScope } from "@/lib/auth/api-key-scopes";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsed: string | null;
  createdAt: string;
}

type MintedKey = ApiKeyRow & { token: string };

const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  read: "Read",
  "items:write": "Write items",
  "documents:write": "Write documents",
};

interface ApiKeysManagerProps {
  orgId: string;
}

export function ApiKeysManager({ orgId }: ApiKeysManagerProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokingKey, setRevokingKey] = useState<ApiKeyRow | null>(null);
  const [mintedToken, setMintedToken] = useState("");
  const [copied, setCopied] = useState(false);

  const [formName, setFormName] = useState("");
  const [formScopes, setFormScopes] = useState<ApiKeyScope[]>([]);
  const [formExpiry, setFormExpiry] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const apiBase = `/api/v1/orgs/${orgId}/api-keys`;

  const keysQueryKey = useOrgQueryKey("api-keys");
  const {
    data: keys = [],
    isLoading: loading,
    isError,
    refetch,
  } = useQuery({
    queryKey: keysQueryKey,
    queryFn: () => jsonFetch<ApiKeyRow[]>(apiBase),
  });

  function openCreateDialog() {
    setFormName("");
    setFormScopes([]);
    setFormExpiry("");
    setErrors({});
    setCreateDialogOpen(true);
  }

  function clearError(field: string) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function toggleScope(scope: ApiKeyScope) {
    setFormScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
    clearError("scopes");
  }

  function validateForm(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!formName.trim()) next.name = "Name is required";
    if (formScopes.length === 0) next.scopes = "Select at least one scope";
    return next;
  }

  const createMutation = useOrgMutation<
    MintedKey,
    Error,
    { name: string; scopes: ApiKeyScope[]; expiresAt: string | null }
  >({
    mutationFn: (payload) =>
      jsonFetch(apiBase, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    invalidate: [["api-keys"]],
    onSuccess: (data) => {
      setMintedToken(data?.token ?? "");
      setCreateDialogOpen(false);
      if (data?.token) setTokenDialogOpen(true);
    },
    onError: (err) => notifyError(err, "Couldn't create the API key."),
  });

  const revokeMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["api-keys"]],
    onSuccess: () => {
      setRevokeDialogOpen(false);
      setRevokingKey(null);
    },
    onError: (err) => notifyError(err, "Couldn't revoke the API key."),
  });

  const submitting = createMutation.isPending || revokeMutation.isPending;

  function handleCreate() {
    const next = validateForm();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    // The expiry input is a date (no time); send it as an end-of-day ISO
    // instant so `z.string().datetime()` on the server accepts it.
    const expiresAt = formExpiry
      ? new Date(`${formExpiry}T23:59:59.000Z`).toISOString()
      : null;
    createMutation.mutate({
      name: formName.trim(),
      scopes: formScopes,
      expiresAt,
    });
  }

  function openRevokeDialog(key: ApiKeyRow) {
    setRevokingKey(key);
    setRevokeDialogOpen(true);
  }

  function handleRevoke() {
    if (!revokingKey) return;
    revokeMutation.mutate(revokingKey.id);
  }

  function copyToken() {
    navigator.clipboard.writeText(mintedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-8 w-32" />
        </div>
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col gap-6">
        <LoadError
          onRetry={() => {
            refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Button onClick={openCreateDialog}>
          <Plus className="mr-1 h-4 w-4" />
          Create key
        </Button>
      </div>

      {keys.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] py-12">
          <KeyRound className="h-10 w-10 text-[var(--text-muted)]/40" />
          <div className="text-center">
            <p className="text-sm font-medium text-[var(--text-muted)]">
              No API keys yet
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Create a key to call the Cosmos API with a bearer token.
            </p>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center gap-4 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-[var(--text)]">
                    {key.name}
                  </span>
                  <code className="rounded bg-[var(--bg-muted,var(--surface))] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                    cosmos_{key.prefix}_…
                  </code>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {key.scopes.map((scope) => (
                    <Badge key={scope} variant="neutral" className="text-[10px]">
                      {SCOPE_LABELS[scope as ApiKeyScope] ?? scope}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5 text-xs text-[var(--text-muted)]">
                <span>
                  Last used:{" "}
                  {key.lastUsed
                    ? new Date(key.lastUsed).toLocaleString()
                    : "never"}
                </span>
                <span>
                  {key.expiresAt
                    ? `Expires ${new Date(key.expiresAt).toLocaleDateString()}`
                    : "No expiry"}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => openRevokeDialog(key)}
                title="Revoke"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Grant a bearer token scoped to this organization.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <FormField label="Name" required error={errors.name}>
              {(p) => (
                <Input
                  {...p}
                  value={formName}
                  onChange={(e) => {
                    setFormName(e.target.value);
                    clearError("name");
                  }}
                  placeholder="CI deploy bot"
                  maxLength={120}
                />
              )}
            </FormField>

            <div className="flex flex-col gap-2">
              <Label id="create-scopes-label">
                Scopes
                <span
                  className="text-[var(--status-critical-text,var(--status-critical))]"
                  aria-hidden
                >
                  *
                </span>
              </Label>
              <div
                className="grid grid-cols-1 gap-2"
                role="group"
                aria-labelledby="create-scopes-label"
                aria-describedby={errors.scopes ? "create-scopes-error" : undefined}
              >
                {API_KEY_SCOPES.map((scope) => (
                  <label
                    key={scope}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                      formScopes.includes(scope)
                        ? "border-[var(--primary)] bg-[var(--primary)]/5"
                        : "border-[var(--border)] hover:bg-[var(--surface)]",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={formScopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                      className="rounded border-[var(--border)]"
                    />
                    <span className="font-medium">{SCOPE_LABELS[scope]}</span>
                    <code className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">
                      {scope}
                    </code>
                  </label>
                ))}
              </div>
              {errors.scopes && (
                <p
                  id="create-scopes-error"
                  className="text-xs text-[var(--status-critical-text,var(--status-critical))]"
                >
                  {errors.scopes}
                </p>
              )}
            </div>

            <FormField label="Expires (optional)" error={errors.expiresAt}>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={formExpiry}
                  onChange={(e) => {
                    setFormExpiry(e.target.value);
                    clearError("expiresAt");
                  }}
                />
              )}
            </FormField>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={submitting}>
              {createMutation.isPending && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              )}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time token dialog */}
      <Dialog
        open={tokenDialogOpen}
        onOpenChange={(open) => {
          setTokenDialogOpen(open);
          // Don't let the plaintext token linger in React state after the
          // one-time dialog closes.
          if (!open) setMintedToken("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>
              Copy this now — it will not be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 py-2">
            <code className="flex-1 break-all rounded-md border border-[var(--border)] bg-[var(--bg-muted,var(--surface))] px-3 py-2 font-mono text-xs">
              {mintedToken}
            </code>
            <Button variant="outline" size="icon" onClick={copyToken}>
              {copied ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setTokenDialogOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm dialog */}
      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[var(--status-critical-text,var(--status-critical))]" />
              Revoke API key
            </DialogTitle>
            <DialogDescription>
              {revokingKey
                ? `Revoke "${revokingKey.name}"? Any client using this key will immediately lose access. This can't be undone.`
                : "Revoke this key?"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevoke}
              disabled={submitting}
            >
              {revokeMutation.isPending && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              )}
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
