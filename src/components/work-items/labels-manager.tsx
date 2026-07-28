"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Tag, Trash2, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { usePermissions } from "@/components/providers/permissions-provider";
import { Permission } from "@/lib/rbac/permissions";

interface OrgLabel {
  id: string;
  name: string;
  color: string | null;
  itemCount: number;
}

interface ProjectOption {
  id: string;
  name: string;
  key: string;
}

const ALL = "__all__";

/**
 * The org's label catalogue.
 *
 * Labels used to be bare strings on each work item, so there was no list of
 * what an org actually uses and no way to fix a name once it spread. This is
 * that list: what exists, how much each is used, and the operations that were
 * impossible before — rename everywhere, merge a duplicate away, delete.
 */
export function LabelsManager({ orgId }: { orgId: string }) {
  const { can } = usePermissions();
  const canManage = can(Permission.ORG_MANAGE_SETTINGS);
  const canCreate = can(Permission.ITEM_UPDATE);

  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<string>(ALL);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<OrgLabel | null>(null);
  const [deleting, setDeleting] = useState(false);

  const labelsKey = useOrgQueryKey("labels", projectId);
  const projectsKey = useOrgQueryKey("projects");

  const labelsQuery = useQuery({
    queryKey: labelsKey,
    queryFn: () =>
      jsonFetch<OrgLabel[]>(
        `/api/v1/orgs/${orgId}/labels${projectId === ALL ? "" : `?projectId=${projectId}`}`,
      ),
  });

  const projectsQuery = useQuery({
    queryKey: projectsKey,
    queryFn: () => jsonFetch<ProjectOption[]>(`/api/v1/orgs/${orgId}/projects`),
    staleTime: 60_000,
  });

  const labels = useMemo(() => labelsQuery.data ?? [], [labelsQuery.data]);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["org"] });
  }

  async function createLabel() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setNewName("");
      refresh();
      toast.success(`Label “${name}” added`);
    } catch (err) {
      notifyError(err, "Couldn't add that label.");
    } finally {
      setCreating(false);
    }
  }

  async function rename(label: OrgLabel) {
    const name = editName.trim();
    if (!name || name === label.name) {
      setEditingId(null);
      return;
    }
    setSaving(true);
    try {
      const res = await jsonFetch<{ merged: boolean; itemsTouched: number }>(
        `/api/v1/orgs/${orgId}/labels/${label.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      setEditingId(null);
      refresh();
      // Merging is a bigger deal than renaming and the user may not have
      // realised the target already existed — say so rather than silently
      // making one label disappear.
      toast.success(
        res.merged
          ? `Merged into “${name}” · ${res.itemsTouched} item${res.itemsTouched === 1 ? "" : "s"} moved`
          : `Renamed to “${name}”`,
      );
    } catch (err) {
      notifyError(err, "Couldn't rename that label.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(label: OrgLabel) {
    setDeleting(true);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/labels/${label.id}`, { method: "DELETE" });
      setConfirmDelete(null);
      refresh();
      toast.success(`Deleted “${label.name}”`);
    } catch (err) {
      notifyError(err, "Couldn't delete that label.");
    } finally {
      setDeleting(false);
    }
  }

  const scopeNote =
    projectId === ALL
      ? "across every project"
      : "in the selected project";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={projectId} onValueChange={(v) => setProjectId(v ?? ALL)}>
          <SelectTrigger className="w-64" aria-label="Filter usage by project">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {(projectsQuery.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.key} · {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {canCreate && (
          <div className="ml-auto flex items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createLabel();
              }}
              placeholder="New label…"
              aria-label="New label name"
              className="w-56"
            />
            <Button onClick={() => void createLabel()} disabled={creating || !newName.trim()}>
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Add
            </Button>
          </div>
        )}
      </div>

      {/* The project filter narrows the COUNT, not the list — hiding labels
          unused in a project would hide exactly the ones worth cleaning up. */}
      <p className="text-xs text-[var(--text-muted)]">
        Showing every label in this organization; usage counted {scopeNote}.
      </p>

      {labelsQuery.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-[var(--radius)]" />
          ))}
        </div>
      ) : labels.length === 0 ? (
        <EmptyState
          illustration={
            <Tag className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />
          }
          title="No labels yet"
          description="Labels you add to work items will collect here, where they can be renamed, merged or removed across every project at once."
        />
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          {labels.map((label) => {
            const isEditing = editingId === label.id;
            return (
              <li key={label.id} className="flex items-center gap-3 p-3">
                {isEditing ? (
                  <>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename(label);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      aria-label={`Rename ${label.name}`}
                      className="max-w-xs"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      onClick={() => void rename(label)}
                      disabled={saving}
                      aria-label="Save name"
                    >
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel rename"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Badge variant="neutral" className="gap-1.5">
                      <Tag className="h-3 w-3" aria-hidden />
                      {label.name}
                    </Badge>
                    <span className="text-xs text-[var(--text-muted)]">
                      {label.itemCount} item{label.itemCount === 1 ? "" : "s"}
                    </span>
                    {canManage && (
                      <div className="ml-auto flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingId(label.id);
                            setEditName(label.name);
                          }}
                          aria-label={`Rename ${label.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDelete(label)}
                          aria-label={`Delete ${label.name}`}
                        >
                          <Trash2 className="h-4 w-4 text-[var(--danger)]" />
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{confirmDelete?.name}”?</DialogTitle>
            <DialogDescription>
              {confirmDelete?.itemCount
                ? `This removes it from ${confirmDelete.itemCount} work item${confirmDelete.itemCount === 1 ? "" : "s"} across every project. They keep their other labels.`
                : "Nothing is using this label."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && void remove(confirmDelete)}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
