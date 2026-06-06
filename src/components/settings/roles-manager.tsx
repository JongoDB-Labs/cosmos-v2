"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { Permission } from "@/lib/rbac/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ShieldCheck, Plus, Pencil, Trash2, Users } from "lucide-react";

// A deny rule NARROWS access for members holding the role (see
// workRolePolicySchema server-side). v1 of this editor authors deny-only rules
// whose condition is one of: unconditional, owns_resource, or in_project. (The
// API also accepts attribute conditions; those are authorable via API only and
// are preserved untouched here if present.)
type DenyCondition = { rel: string } | { attr: string; op: string; value: unknown };
interface DenyPolicy {
  id?: string;
  effect: "deny";
  actions: string[];
  conditions: DenyCondition[];
}
type ConditionMode = "always" | "owns_resource" | "in_project" | "custom";

function conditionMode(p: DenyPolicy): ConditionMode {
  if (!p.conditions || p.conditions.length === 0) return "always";
  if (p.conditions.length === 1 && "rel" in p.conditions[0]) {
    const rel = (p.conditions[0] as { rel: string }).rel;
    if (rel === "owns_resource" || rel === "in_project") return rel;
  }
  return "custom"; // attr/multi-condition policy authored via API — preserve as-is
}

function conditionsForMode(mode: ConditionMode, prev: DenyCondition[]): DenyCondition[] {
  if (mode === "always") return [];
  if (mode === "owns_resource") return [{ rel: "owns_resource" }];
  if (mode === "in_project") return [{ rel: "in_project" }];
  return prev; // "custom" — leave untouched
}

interface WorkRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  grants: string[]; // permission keys
  policies: DenyPolicy[];
  memberCount: number;
}
interface OrgMemberLite {
  id: string;
  user?: { displayName?: string; email?: string };
  displayName?: string;
}

// Group permission keys by their leading segment for a browsable checklist.
const ALL_PERMISSIONS = Object.keys(Permission);
function groupOf(key: string): string {
  const seg = key.split("_")[0];
  return seg.charAt(0) + seg.slice(1).toLowerCase();
}
function labelOf(key: string): string {
  return key
    .split("_")
    .slice(1)
    .join(" ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}
const PERMISSION_GROUPS = ALL_PERMISSIONS.reduce<Record<string, string[]>>(
  (acc, k) => {
    (acc[groupOf(k)] ??= []).push(k);
    return acc;
  },
  {},
);

export function RolesManager({ orgId }: { orgId: string }) {
  const rolesKey = useOrgQueryKey("work-roles");
  const base = `/api/v1/orgs/${orgId}/work-roles`;

  const rolesQ = useQuery({
    queryKey: rolesKey,
    queryFn: () => jsonFetch<WorkRole[]>(base),
  });
  const roles = rolesQ.data ?? [];

  const [editing, setEditing] = useState<WorkRole | "new" | null>(null);
  const [assigning, setAssigning] = useState<WorkRole | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkRole | null>(null);

  const deleteRole = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${base}/${id}`, { method: "DELETE" }),
    invalidate: [["work-roles"]],
  });

  if (rolesQ.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (rolesQ.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-muted-foreground">Couldn&apos;t load roles.</p>
        <Button variant="outline" size="sm" onClick={() => rolesQ.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4 mr-1" /> New role
        </Button>
      </div>

      {roles.length === 0 ? (
        <EmptyState
          illustration={<ShieldCheck className="size-10" />}
          title="No work roles yet"
          description="Create job-function roles (e.g. Finance approver, Team lead) that grant extra permissions on top of the org role, and assign members to them."
        />
      ) : (
        <div className="space-y-2">
          {roles.map((r) => (
            <div key={r.id} className="flex items-start justify-between gap-3 rounded-lg border bg-card p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-sm">{r.name}</h3>
                  <Badge variant="neutral" className="text-[10px]">{r.key}</Badge>
                </div>
                {r.description && (
                  <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{r.description}</p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  {r.grants.length} permission{r.grants.length === 1 ? "" : "s"} · {r.memberCount} member{r.memberCount === 1 ? "" : "s"}
                  {Array.isArray(r.policies) && r.policies.length > 0 && (
                    <> · {r.policies.length} deny rule{r.policies.length === 1 ? "" : "s"}</>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="icon-sm" variant="ghost" aria-label="Assign members" title="Assign members" onClick={() => setAssigning(r)}>
                  <Users className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Edit role" title="Edit" onClick={() => setEditing(r)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Delete role" title="Delete" onClick={() => setDeleteTarget(r)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <RoleEditor base={base} role={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      )}
      {assigning && (
        <MemberAssigner orgId={orgId} base={base} role={assigning} onClose={() => setAssigning(null)} />
      )}

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this role?</DialogTitle>
            <DialogDescription>
              <span className="font-medium">{deleteTarget?.name}</span> and its member assignments will be removed. Members keep their org-role permissions. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) deleteRole.mutate(deleteTarget.id, { onSuccess: () => setDeleteTarget(null) });
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RoleEditor({ base, role, onClose }: { base: string; role: WorkRole | null; onClose: () => void }) {
  const [name, setName] = useState(role?.name ?? "");
  const [key, setKey] = useState(role?.key ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [grants, setGrants] = useState<Set<string>>(new Set(role?.grants ?? []));
  const [policies, setPolicies] = useState<DenyPolicy[]>(
    Array.isArray(role?.policies) ? role!.policies : [],
  );

  const save = useOrgMutation<unknown, Error, void>({
    mutationFn: () => {
      // Drop deny rules with no actions (they reference nothing) so the API
      // schema (min 1 action) doesn't reject the whole save.
      const cleanPolicies = policies.filter((p) => p.actions.length > 0);
      const body = {
        name,
        description: description || null,
        grants: [...grants],
        policies: cleanPolicies,
      };
      return role
        ? jsonFetch(`${base}/${role.id}`, { method: "PUT", body: JSON.stringify(body) })
        : jsonFetch(base, { method: "POST", body: JSON.stringify({ key, ...body }) });
    },
    invalidate: [["work-roles"]],
  });

  function toggle(k: string) {
    setGrants((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function addPolicy() {
    setPolicies((prev) => [...prev, { effect: "deny", actions: [], conditions: [] }]);
  }
  function removePolicy(i: number) {
    setPolicies((prev) => prev.filter((_, idx) => idx !== i));
  }
  function togglePolicyAction(i: number, action: string) {
    setPolicies((prev) =>
      prev.map((p, idx) => {
        if (idx !== i) return p;
        const has = p.actions.includes(action);
        return {
          ...p,
          actions: has ? p.actions.filter((a) => a !== action) : [...p.actions, action],
        };
      }),
    );
  }
  function setPolicyMode(i: number, mode: ConditionMode) {
    setPolicies((prev) =>
      prev.map((p, idx) =>
        idx === i ? { ...p, conditions: conditionsForMode(mode, p.conditions) } : p,
      ),
    );
  }

  const canSave = name.trim() && (role || /^[a-z][a-z0-9_]*$/.test(key));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{role ? "Edit role" : "New work role"}</DialogTitle>
          <DialogDescription>
            Grants are added on top of the member&apos;s org role. You can only grant permissions you hold yourself.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="role-name">Name</Label>
              <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Finance approver" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-key">Key</Label>
              <Input id="role-key" value={key} disabled={!!role} onChange={(e) => setKey(e.target.value)} placeholder="finance_approver" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-desc">Description</Label>
            <Input id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this role is for" />
          </div>
          <div className="space-y-2">
            <Label>Granted permissions ({grants.size})</Label>
            <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border p-3">
              {Object.entries(PERMISSION_GROUPS).map(([group, keys]) => (
                <div key={group}>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</p>
                  <div className="grid grid-cols-2 gap-1">
                    {keys.map((k) => (
                      <label key={k} className="flex items-center gap-2 text-xs">
                        <input type="checkbox" className="size-3.5 rounded border-border" checked={grants.has(k)} onChange={() => toggle(k)} />
                        {labelOf(k)}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Access policies (deny rules)</Label>
              <Button size="sm" variant="outline" onClick={addPolicy}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add deny rule
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Deny rules REMOVE access from members holding this role — even when their org role would
              otherwise allow it. (Roles widen access via the permissions above and narrow it via deny
              rules; there are no allow rules.)
            </p>
            {policies.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                No deny rules. Add one to strip specific actions from this role (e.g. a contractor role
                denied <code>Finance manage</code>, or an approver denied actions on resources they own).
              </p>
            ) : (
              <div className="space-y-2">
                {policies.map((p, i) => {
                  const mode = conditionMode(p);
                  return (
                    <div key={i} className="space-y-2 rounded-md border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs font-medium">
                          Deny {p.actions.length} action{p.actions.length === 1 ? "" : "s"}
                        </span>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Remove deny rule"
                          onClick={() => removePolicy(i)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {mode === "custom" ? (
                        <p className="text-xs text-muted-foreground">
                          Advanced attribute condition — editable via the API only; preserved as-is.
                        </p>
                      ) : (
                        <label className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">Applies:</span>
                          <select
                            className="rounded border bg-background px-2 py-1 text-xs"
                            value={mode}
                            onChange={(e) => setPolicyMode(i, e.target.value as ConditionMode)}
                          >
                            <option value="always">Always (strip the action)</option>
                            <option value="owns_resource">Only on resources the member owns</option>
                            <option value="in_project">Only when the member is in the project</option>
                          </select>
                        </label>
                      )}
                      <div className="max-h-40 space-y-2 overflow-y-auto rounded border p-2">
                        {Object.entries(PERMISSION_GROUPS).map(([group, keys]) => (
                          <div key={group}>
                            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              {group}
                            </p>
                            <div className="grid grid-cols-2 gap-1">
                              {keys.map((k) => (
                                <label key={k} className="flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    className="size-3.5 rounded border-border"
                                    checked={p.actions.includes(k)}
                                    onChange={() => togglePolicyAction(i, k)}
                                  />
                                  {labelOf(k)}
                                </label>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!canSave || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            {save.isPending ? "Saving…" : "Save role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberAssigner({ orgId, base, role, onClose }: { orgId: string; base: string; role: WorkRole; onClose: () => void }) {
  const membersQ = useQuery({
    queryKey: useOrgQueryKey("members", "for-roles"),
    queryFn: () => jsonFetch<OrgMemberLite[]>(`/api/v1/orgs/${orgId}/members`),
  });
  const assignedQ = useQuery({
    queryKey: useOrgQueryKey("work-roles", role.id, "members"),
    queryFn: () => jsonFetch<{ orgMemberIds: string[] }>(`${base}/${role.id}/members`),
  });

  const [selected, setSelected] = useState<Set<string> | null>(null);
  const current = useMemo(
    () => selected ?? new Set(assignedQ.data?.orgMemberIds ?? []),
    [selected, assignedQ.data],
  );

  const save = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`${base}/${role.id}/members`, {
        method: "PUT",
        body: JSON.stringify({ orgMemberIds: [...current] }),
      }),
    invalidate: [["work-roles"]],
  });

  const members = membersQ.data ?? [];
  const loading = membersQ.isLoading || assignedQ.isLoading;

  function toggle(id: string) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign “{role.name}”</DialogTitle>
          <DialogDescription>Select the members who should hold this role.</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto py-1">
            {members.map((m) => {
              const display = m.user?.displayName ?? m.displayName ?? m.user?.email ?? "Member";
              return (
                <label key={m.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                  <input type="checkbox" className="size-4 rounded border-border" checked={current.has(m.id)} onChange={() => toggle(m.id)} />
                  {display}
                </label>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending || loading} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            {save.isPending ? "Saving…" : "Save assignments"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
