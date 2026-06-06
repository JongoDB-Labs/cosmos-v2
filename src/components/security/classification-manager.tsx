"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tag, Plus, Pencil, Trash2 } from "lucide-react";

type ClassificationLevel =
  | "PUBLIC"
  | "UNCLASSIFIED"
  | "FOUO"
  | "CUI"
  | "CONFIDENTIAL";

interface DataClassification {
  id: string;
  orgId: string;
  projectId: string | null;
  level: ClassificationLevel;
  markings: string[];
  handlingInstructions: string;
  appliedById: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectOption {
  id: string;
  name: string;
  key: string;
}

const LEVELS: { value: ClassificationLevel; label: string }[] = [
  { value: "PUBLIC", label: "Public" },
  { value: "UNCLASSIFIED", label: "Unclassified" },
  { value: "FOUO", label: "FOUO" },
  { value: "CUI", label: "CUI" },
  { value: "CONFIDENTIAL", label: "Confidential" },
];

function levelBadge(level: ClassificationLevel) {
  const colors: Record<ClassificationLevel, string> = {
    PUBLIC: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    UNCLASSIFIED: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    FOUO: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    CUI: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
    CONFIDENTIAL: "bg-red-500/15 text-red-700 dark:text-red-400",
  };
  return (
    <Badge className={cn("gap-1", colors[level])}>
      {LEVELS.find((l) => l.value === level)?.label ?? level}
    </Badge>
  );
}

interface ClassificationFormData {
  projectId: string;
  level: ClassificationLevel;
  markings: string;
  handlingInstructions: string;
}

const emptyForm: ClassificationFormData = {
  projectId: "",
  level: "UNCLASSIFIED",
  markings: "",
  handlingInstructions: "",
};

function ClassificationFormDialog({
  open,
  onOpenChange,
  onSave,
  initial,
  mode,
  saving,
  projects,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSave: (data: ClassificationFormData) => void;
  initial: ClassificationFormData;
  mode: "create" | "edit";
  saving: boolean;
  projects: ProjectOption[];
}) {
  const [form, setForm] = useState<ClassificationFormData>(initial);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setForm(initial);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "create"
              ? "Add Classification"
              : "Edit Classification"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Apply a data classification label."
              : "Update the classification details."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>Project (optional)</Label>
            <Select
              value={form.projectId || "none"}
              onValueChange={(v) =>
                setForm((p) => ({
                  ...p,
                  projectId: !v || v === "none" ? "" : v,
                }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— No project —</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.key} - {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Classification Level</Label>
            <Select
              value={form.level}
              onValueChange={(v) =>
                setForm((p) => ({ ...p, level: v as ClassificationLevel }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVELS.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Markings</Label>
            <Input
              value={form.markings}
              onChange={(e) =>
                setForm((p) => ({ ...p, markings: e.target.value }))
              }
              placeholder="Comma-separated, e.g. NOFORN, REL TO USA"
            />
            <p className="text-xs text-muted-foreground">
              Separate multiple markings with commas
            </p>
          </div>
          <div className="grid gap-2">
            <Label>Handling Instructions</Label>
            <Textarea
              value={form.handlingInstructions}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  handlingInstructions: e.target.value,
                }))
              }
              placeholder="Describe handling requirements"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => onSave(form)}>
            {saving ? "Saving..." : mode === "create" ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ClassificationManager({ orgId }: { orgId: string }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<DataClassification | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DataClassification | null>(
    null
  );
  const [projects, setProjects] = useState<ProjectOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/projects`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setProjects(Array.isArray(data) ? data : data.projects || []);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const queryKey = useOrgQueryKey("classifications");
  const {
    data: classifications = [],
    isLoading: loading,
    isError,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: async () => {
      const data = await jsonFetch<
        DataClassification[] | { classifications: DataClassification[] }
      >(`/api/v1/orgs/${orgId}/classifications`);
      return Array.isArray(data) ? data : data.classifications ?? [];
    },
  });

  function payloadOf(form: ClassificationFormData) {
    return {
      projectId: form.projectId || null,
      level: form.level,
      markings: form.markings
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      handlingInstructions: form.handlingInstructions,
    };
  }

  const createMutation = useOrgMutation<
    DataClassification,
    Error,
    ClassificationFormData
  >({
    mutationFn: (form) =>
      jsonFetch(`/api/v1/orgs/${orgId}/classifications`, {
        method: "POST",
        body: JSON.stringify(payloadOf(form)),
      }),
    invalidate: [["classifications"]],
    onSuccess: () => setCreateOpen(false),
    onError: (err) => notifyError(err, "Couldn't create the classification."),
  });

  const editMutation = useOrgMutation<
    DataClassification,
    Error,
    { id: string; form: ClassificationFormData }
  >({
    mutationFn: ({ id, form }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/classifications/${id}`, {
        method: "PUT",
        body: JSON.stringify(payloadOf(form)),
      }),
    invalidate: [["classifications"]],
    onSuccess: () => setEditTarget(null),
    onError: (err) => notifyError(err, "Couldn't save the classification."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/classifications/${id}`, {
        method: "DELETE",
      }),
    invalidate: [["classifications"]],
    onSuccess: () => setDeleteTarget(null),
    onError: (err) => notifyError(err, "Couldn't delete the classification."),
  });

  const saving =
    createMutation.isPending ||
    editMutation.isPending ||
    deleteMutation.isPending;

  function handleCreate(form: ClassificationFormData) {
    createMutation.mutate(form);
  }

  function handleEdit(form: ClassificationFormData) {
    if (!editTarget) return;
    editMutation.mutate({ id: editTarget.id, form });
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id);
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-40" />
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Tag className="size-5" />
              Data Classifications
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Manage data classification labels and handling requirements
            </p>
          </div>
        </div>
        <LoadError
          onRetry={() => {
            refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Tag className="size-5" />
            Data Classifications
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage data classification labels and handling requirements
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4 mr-1" />
          Add Classification
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Scope
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Level
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Markings
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Handling Instructions
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Applied By
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Date
                </th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {classifications.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    No classifications defined
                  </td>
                </tr>
              ) : (
                classifications.map((cls) => (
                  <tr
                    key={cls.id}
                    className="border-b last:border-b-0 hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-3 py-2 text-sm">
                      {cls.projectId ? (
                        <span className="font-mono text-xs">
                          {cls.projectId.substring(0, 8)}...
                        </span>
                      ) : (
                        <Badge variant="neutral">Org-wide</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">{levelBadge(cls.level)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {cls.markings.length > 0
                          ? cls.markings.map((m, i) => (
                              <Badge
                                key={i}
                                variant="neutral"
                                showDot={false}
                                className="text-xs"
                              >
                                {m}
                              </Badge>
                            ))
                          : "-"}
                      </div>
                    </td>
                    <td className="px-3 py-2 max-w-[200px] truncate text-xs text-muted-foreground">
                      {cls.handlingInstructions || "-"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {cls.appliedById.substring(0, 8)}...
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {new Date(cls.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => setEditTarget(cls)}
                        >
                          <Pencil className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => setDeleteTarget(cls)}
                        >
                          <Trash2 className="size-3 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ClassificationFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSave={handleCreate}
        initial={emptyForm}
        mode="create"
        saving={saving}
        projects={projects}
      />

      {editTarget && (
        <ClassificationFormDialog
          open={!!editTarget}
          onOpenChange={(v) => {
            if (!v) setEditTarget(null);
          }}
          onSave={handleEdit}
          initial={{
            projectId: editTarget.projectId ?? "",
            level: editTarget.level,
            markings: editTarget.markings.join(", "),
            handlingInstructions: editTarget.handlingInstructions,
          }}
          mode="edit"
          saving={saving}
          projects={projects}
        />
      )}

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Classification</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this classification? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={handleDelete}
            >
              {saving ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
