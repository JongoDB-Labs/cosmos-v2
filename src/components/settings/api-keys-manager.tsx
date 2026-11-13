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
import type { ApiKeyScope } from "@/lib/auth/api-key-scopes";
import {
  API_KEY_LIMITS,
  KEY_INACTIVE_TEXT,
  defaultExpiryDate,
  expiryRefusal,
  latestExpiryWithoutManage,
  utcDateInput,
  type KeyInactiveReason,
} from "@/lib/auth/api-key-policy";
import { formatDateStable } from "@/lib/format/stable-date";
import { LocalTimestamp } from "@/components/ui/local-timestamp";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  /** Projects the key is limited to. Empty = org-wide. */
  projectIds?: string[];
  expiresAt: string | null;
  /** When it really stops: `expiresAt`, or sooner once its creator can't manage keys. */
  effectiveExpiresAt?: string | null;
  /** Why it authenticates nobody right now (the verifier's rule), or null when it works. */
  inactiveReason?: KeyInactiveReason | null;
  lastUsed: string | null;
  createdAt: string;
  /** Who made the key. Null when their account was deleted. */
  createdBy?: { id: string; name: string } | null;
}

type MintedKey = ApiKeyRow & { token: string };

const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  read: "Read",
  "members:read": "Read members' email addresses",
  "items:write": "Write items",
  "items:delete": "Delete items",
  "planning:write": "Write plans (milestones, goals, KPIs, intervals)",
  "documents:write": "Write documents",
  "time:read": "Read time",
  "time:write": "Log time",
  "webhooks:manage": "Manage webhooks",
  "audit:read": "Read the audit log",
  "rules:run": "Run checks",
};

interface ApiKeysManagerProps {
  orgId: string;
  /** The signed-in person: their keys are the ones under "Your API keys". */
  currentUserId: string;
  /** Holds API_KEY_MANAGE in their session: sees and revokes every key. */
  managesAll: boolean;
  /** May make a key that never expires: API_KEY_MANAGE as a key sees it (no owner break-glass). */
  mintsWithoutLimit: boolean;
  /** Why they can't create a key right now (switch, role, single sign-on), or null when they can. */
  createRefusal: string | null;
  /** The org has turned off "Members can create their own API keys". */
  memberKeysOff: boolean;
  /** Every scope, with why this person can't use it (null when they can).
   *  From scopeVerdicts, the function the mint route checks with. */
  scopes: { scope: ApiKeyScope; refusal: string | null }[];
}

/** The expiry bounds the create form works within, taken when it opens. */
interface ExpiryBounds {
  min: string;
  max: string | undefined;
}

/** A project, as the picker needs it. */
interface PickerProject {
  id: string;
  key: string;
  name: string;
}

/** The date input holds a day; a key made for that day lasts to its end, in UTC. */
function expiryInstant(day: string): Date | null {
  return day ? new Date(`${day}T23:59:59.000Z`) : null;
}

export function ApiKeysManager({
  orgId,
  currentUserId,
  managesAll,
  mintsWithoutLimit,
  createRefusal,
  memberKeysOff,
  scopes,
}: ApiKeysManagerProps) {
  const canCreate = createRefusal === null;
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokingKey, setRevokingKey] = useState<ApiKeyRow | null>(null);
  const [mintedToken, setMintedToken] = useState("");
  const [copied, setCopied] = useState(false);

  const [formName, setFormName] = useState("");
  const [formScopes, setFormScopes] = useState<ApiKeyScope[]>([]);
  /** All projects (org-wide) vs a chosen few — the same shape as a fine-grained
   *  token's "All repositories" / "Only select repositories". */
  const [formAllProjects, setFormAllProjects] = useState(true);
  const [formProjectIds, setFormProjectIds] = useState<string[]>([]);
  const [formExpiry, setFormExpiry] = useState("");
  const [expiryBounds, setExpiryBounds] = useState<ExpiryBounds>({ min: "", max: undefined });
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

  // The projects available to scope a key to. Lazy — only fetched once the
  // create dialog is open, since most visits to this page are to read or revoke
  // an existing key rather than mint a new one.
  const projectsQueryKey = useOrgQueryKey("api-key-projects");
  const { data: projects = [] } = useQuery({
    queryKey: projectsQueryKey,
    enabled: createDialogOpen,
    queryFn: () =>
      jsonFetch<PickerProject[]>(`/api/v1/orgs/${orgId}/projects`),
  });

  function openCreateDialog() {
    setFormName("");
    setFormScopes([]);
    setFormAllProjects(true);
    setFormProjectIds([]);
    // Taken now, in the browser, rather than while rendering: "today" on the
    // server and in the browser can differ, and a date in the markup would.
    const now = new Date();
    setFormExpiry(defaultExpiryDate(now));
    setExpiryBounds({
      min: utcDateInput(now),
      max: mintsWithoutLimit ? undefined : utcDateInput(latestExpiryWithoutManage(now)),
    });
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
    // Without this the form would submit an empty list, which the server reads
    // as ORG-WIDE — the opposite of what "only selected projects" asked for.
    if (!formAllProjects && formProjectIds.length === 0) {
      next.projects = "Select at least one project, or choose All projects";
    }
    // The server's own rule, so the form says what the server would.
    const expiry = expiryRefusal(expiryInstant(formExpiry), mintsWithoutLimit, new Date());
    if (expiry) next.expiresAt = expiry;
    return next;
  }

  const createMutation = useOrgMutation<
    MintedKey,
    Error,
    {
      name: string;
      scopes: ApiKeyScope[];
      projectIds: string[];
      expiresAt: string | null;
    }
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
    const expiresAt = expiryInstant(formExpiry)?.toISOString() ?? null;
    createMutation.mutate({
      name: formName.trim(),
      scopes: formScopes,
      // Empty means org-wide, which is what "All projects" sends.
      projectIds: formAllProjects ? [] : formProjectIds,
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

  const ownKeys = keys.filter((k) => k.createdBy?.id === currentUserId);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-labelledby="own-keys-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="own-keys-heading" className="text-sm font-semibold text-[var(--text)]">
              Your API keys
            </h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              A key acts as you. It can only do what you can do, and only what its scopes allow.
            </p>
          </div>
          {canCreate && (
            <Button onClick={openCreateDialog}>
              <Plus className="mr-1 h-4 w-4" />
              Create key
            </Button>
          )}
        </div>

        {createRefusal && (
          <p className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text)]">
            {memberKeysOff && !mintsWithoutLimit
              ? "An admin has turned off API keys for members, so you can't create keys and your existing keys don't work."
              : createRefusal}
          </p>
        )}

        {ownKeys.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] py-12">
            <KeyRound className="h-10 w-10 text-[var(--text-muted)]/40" />
            <div className="text-center">
              <p className="text-sm font-medium text-[var(--text-muted)]">
                You have no API keys
              </p>
              {canCreate && (
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Create a key to use the Cosmos API as yourself.
                </p>
              )}
            </div>
          </div>
        ) : (
          <KeyList rows={ownKeys} onRevoke={openRevokeDialog} />
        )}
      </section>

      {managesAll && (
        <section className="flex flex-col gap-3" aria-labelledby="all-keys-heading">
          <div>
            <h2 id="all-keys-heading" className="text-sm font-semibold text-[var(--text)]">
              All keys in this organization
            </h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {memberKeysOff
                ? "Only admins can create keys right now, and keys made by other members don't work. You can change this in Security settings."
                : "Everyone's keys, including yours. Revoke any key you don't trust."}
            </p>
          </div>
          {keys.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">No one has created a key yet.</p>
          ) : (
            <KeyList rows={keys} showCreator onRevoke={openRevokeDialog} />
          )}
        </section>
      )}

      {/* Create dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              The key acts as you in this organization. Choose what it may do.
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
                {scopes.map(({ scope, refusal }) => (
                  <label
                    key={scope}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                      refusal
                        ? "cursor-not-allowed border-[var(--border)] opacity-60"
                        : formScopes.includes(scope)
                          ? "cursor-pointer border-[var(--primary)] bg-[var(--primary)]/5"
                          : "cursor-pointer border-[var(--border)] hover:bg-[var(--surface)]",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={formScopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                      disabled={refusal !== null}
                      aria-describedby={refusal ? `scope-refusal-${scope}` : undefined}
                      className="rounded border-[var(--border)]"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{SCOPE_LABELS[scope]}</span>
                      {refusal && (
                        <span id={`scope-refusal-${scope}`} className="text-[10px] text-[var(--text-muted)]">
                          {refusal}
                        </span>
                      )}
                    </span>
                    <code className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">
                      {scope}
                    </code>
                  </label>
                ))}
              </div>
            </div>

            {/* Project scope. Two states, like a fine-grained token's "All
                repositories" / "Only select repositories": a key is either
                org-wide or limited to named projects. Empty means org-wide,
                which is what every key minted before this existed already had —
                so the default here matches their behaviour exactly. */}
            <div className="flex flex-col gap-2">
              <Label id="create-projects-label">Project access</Label>
              <div
                className="flex flex-col gap-2"
                role="group"
                aria-labelledby="create-projects-label"
              >
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-xs hover:bg-[var(--surface)]">
                  <input
                    type="radio"
                    name="project-scope"
                    checked={formAllProjects}
                    onChange={() => setFormAllProjects(true)}
                  />
                  <span className="font-medium">All projects</span>
                  <span className="ml-auto text-[10px] text-[var(--text-muted)]">
                    every project you can see
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-xs hover:bg-[var(--surface)]">
                  <input
                    type="radio"
                    name="project-scope"
                    checked={!formAllProjects}
                    onChange={() => setFormAllProjects(false)}
                  />
                  <span className="font-medium">Only selected projects</span>
                </label>

                {!formAllProjects && (
                  <div className="max-h-44 overflow-y-auto rounded-md border border-[var(--border)] p-2">
                    {projects.length === 0 ? (
                      <p className="px-1 py-2 text-xs text-[var(--text-muted)]">
                        No projects to choose from.
                      </p>
                    ) : (
                      projects.map((p) => (
                        <label
                          key={p.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs hover:bg-[var(--surface)]"
                        >
                          <input
                            type="checkbox"
                            checked={formProjectIds.includes(p.id)}
                            onChange={() =>
                              setFormProjectIds((prev) =>
                                prev.includes(p.id)
                                  ? prev.filter((x) => x !== p.id)
                                  : [...prev, p.id],
                              )
                            }
                          />
                          <code className="font-mono text-[10px] text-[var(--text-muted)]">
                            {p.key}
                          </code>
                          <span className="truncate">{p.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                )}
                {!formAllProjects && formProjectIds.length === 0 && (
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Pick at least one project, or choose All projects.
                  </p>
                )}
              </div>
            </div>

            {errors.scopes && (
              <p
                id="create-scopes-error"
                className="text-xs text-[var(--status-critical-text,var(--status-critical))]"
              >
                {errors.scopes}
              </p>
            )}
            {errors.projects && (
              <p className="text-xs text-[var(--status-critical-text,var(--status-critical))]">
                {errors.projects}
              </p>
            )}

            <FormField
              label={mintsWithoutLimit ? "Expires (optional)" : "Expires"}
              required={!mintsWithoutLimit}
              error={errors.expiresAt}
              hint={
                mintsWithoutLimit
                  ? "Leave it empty for a key that never expires."
                  : `A key can last up to ${API_KEY_LIMITS.maxDaysWithoutManage} days.`
              }
            >
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={formExpiry}
                  min={expiryBounds.min}
                  max={expiryBounds.max}
                  required={!mintsWithoutLimit}
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
            <Button
              variant="outline"
              size="icon"
              onClick={copyToken}
              aria-label={copied ? "Copied" : "Copy API token"}
            >
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
                ? `Revoke "${revokingKey.name}"${
                    revokingKey.createdBy && revokingKey.createdBy.id !== currentUserId
                      ? `, made by ${revokingKey.createdBy.name}`
                      : ""
                  }? Anything using it stops working at once. You can't undo this.`
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

/** A list of keys with a revoke button on each; `showCreator` adds who made it. */
/** A date as a timestamp, from the server's Date or the API's ISO string. */
const instant = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);

/**
 * Whether a key works, and until when. A key that authenticates nobody right
 * now says so, with the reason, rather than showing a date it will never
 * reach. Once its creator can't manage keys, a key stops 366 days after it was
 * made, even one set never to expire, so the row shows that date and says why
 * rather than "No expiry".
 */
function KeyExpiry({ row }: { row: ApiKeyRow }) {
  if (row.inactiveReason) {
    // Wraps rather than squeezing the key's name: a reason is longer than a date.
    return (
      <span className="max-w-64 text-right font-medium text-[var(--status-critical-text,var(--status-critical))]">
        {KEY_INACTIVE_TEXT[row.inactiveReason]}
      </span>
    );
  }
  const effective = row.effectiveExpiresAt === undefined ? row.expiresAt : row.effectiveExpiresAt;
  const limited = effective !== null && instant(effective) !== instant(row.expiresAt);
  return (
    <>
      <span>{effective ? `Expires ${formatDateStable(effective)}` : "No expiry"}</span>
      {limited && <span>366-day limit: its creator can&apos;t manage keys</span>}
    </>
  );
}

function KeyList({
  rows,
  showCreator = false,
  onRevoke,
}: {
  rows: ApiKeyRow[];
  showCreator?: boolean;
  onRevoke: (key: ApiKeyRow) => void;
}) {
  return (
    <div className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      {rows.map((key) => (
        <div key={key.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
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
          {showCreator && (
            <div className="w-40 min-w-0 text-xs text-[var(--text-muted)]">
              <span className="block truncate" title={key.createdBy?.name}>
                {key.createdBy ? `Made by ${key.createdBy.name}` : "Made by a deleted account"}
              </span>
            </div>
          )}
          <div className="flex flex-col items-end gap-0.5 text-xs text-[var(--text-muted)]">
            <span>
              Last used:{" "}
              <LocalTimestamp value={key.lastUsed} fallback="never" />
            </span>
            <KeyExpiry row={key} />
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onRevoke(key)}
            title="Revoke"
            aria-label={`Revoke ${key.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
