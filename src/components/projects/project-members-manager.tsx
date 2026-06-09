"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";

const ROLES = ["MANAGER", "LEAD", "MEMBER", "VIEWER"] as const;
type ProjectRole = (typeof ROLES)[number];

const ROLE_LABEL: Record<ProjectRole, string> = {
  MANAGER: "Manager — admin of this project",
  LEAD: "Lead",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

interface ProjectMember {
  id: string;
  orgMemberId: string;
  role: ProjectRole;
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

interface OrgMember {
  id: string;
  role: string;
  user: { id: string; displayName: string; email: string; avatarUrl: string | null };
}

export function ProjectMembersManager({
  orgId,
  projectId,
  projectName,
  canManage,
}: {
  orgId: string;
  projectId: string;
  projectName: string;
  canManage: boolean;
}) {
  const base = `/api/v1/orgs/${orgId}/projects/${projectId}/members`;
  const membersKey = useOrgQueryKey("project-members", projectId);
  const orgMembersKey = useOrgQueryKey("members", "all");

  const { data: members = [], refetch } = useQuery({
    queryKey: membersKey,
    queryFn: () => jsonFetch<ProjectMember[]>(base),
  });
  const { data: orgMembers = [] } = useQuery({
    queryKey: orgMembersKey,
    queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
    enabled: canManage,
  });

  const [addId, setAddId] = useState("");
  const [addRole, setAddRole] = useState<ProjectRole>("MEMBER");
  const [busy, setBusy] = useState(false);

  const inProject = new Set(members.map((m) => m.orgMemberId));
  const addable = orgMembers.filter((m) => !inProject.has(m.id));

  async function setRole(orgMemberId: string, role: ProjectRole) {
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgMemberId, role }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't update the role.");
      }
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't update the role.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(orgMemberId: string) {
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgMemberId }),
      });
      if (!res.ok) throw new Error("Couldn't remove the member.");
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't remove the member.");
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!addId) return;
    await setRole(addId, addRole);
    setAddId("");
    setAddRole("MEMBER");
    toast.success("Member added to project.");
  }

  function initials(name: string) {
    return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <Users className="h-5 w-5 text-[var(--primary)]" />
        <h1 className="text-xl font-semibold">Members of {projectName}</h1>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        Project-scoped access. A <span className="font-medium">Manager</span> can
        administer this project (incl. its boards) and manage its members, even
        without org-wide admin. Org admins inherit access automatically.
        {!canManage && " You have read-only access here."}
      </p>

      {canManage && addable.length > 0 && (
        <div className="mb-5 flex flex-wrap items-end gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="min-w-[200px] flex-1">
            <Select value={addId} onValueChange={(v) => setAddId(v ?? "")}>
              <SelectTrigger aria-label="Add member">
                <SelectValue placeholder="Add a team member…" />
              </SelectTrigger>
              <SelectContent>
                {addable.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.user.displayName} ({m.user.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Select value={addRole} onValueChange={(v) => setAddRole((v as ProjectRole) ?? "MEMBER")}>
            <SelectTrigger className="w-40" aria-label="Role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>{r[0] + r.slice(1).toLowerCase()}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={add} disabled={!addId || busy}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
      )}

      <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
        {members.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No project members yet.</p>
        ) : (
          members.map((m) => (
            <div key={m.id} className="flex items-center gap-3 p-3">
              <Avatar className="h-8 w-8">
                <AvatarImage src={m.avatarUrl ?? undefined} />
                <AvatarFallback className="text-xs">{initials(m.displayName)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.displayName}</p>
                <p className="truncate text-xs text-muted-foreground">{m.email}</p>
              </div>
              {canManage ? (
                <>
                  <Select value={m.role} onValueChange={(v) => v && setRole(m.orgMemberId, v as ProjectRole)}>
                    <SelectTrigger className="w-36" aria-label={`Role for ${m.displayName}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r} title={ROLE_LABEL[r]}>
                          {r[0] + r.slice(1).toLowerCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${m.displayName}`}
                    disabled={busy}
                    onClick={() => remove(m.orgMemberId)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </>
              ) : (
                <span className="text-xs font-medium text-muted-foreground">
                  {m.role[0] + m.role.slice(1).toLowerCase()}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
