"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Target } from "lucide-react";
import { arrayMove } from "@dnd-kit/sortable";
import { OkrObjectivesView } from "./okr-objectives-view";
import { OkrHealthView } from "./okr-health-view";
import { OkrAlignmentView } from "./okr-alignment-view";
import { ObjectiveLinksDialog } from "./objective-links-dialog";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import type { Objective, KeyResult } from "@/types/models";

interface OkrBoardProps {
  orgId: string;
  projectId: string;
}

export function OkrBoard({ orgId, projectId }: OkrBoardProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newCommitted, setNewCommitted] = useState(true);
  const [newIntervalId, setNewIntervalId] = useState("");
  const [adding, setAdding] = useState(false);

  const [editObjective, setEditObjective] = useState<Objective | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPeriod, setEditPeriod] = useState("");
  const [editParentId, setEditParentId] = useState("");
  // The two fields the 2.247.0 schema added. Without an editor here they were
  // unreachable: the columns and the API accepted them, and nothing in the
  // product could write them.
  const [editCommitted, setEditCommitted] = useState(true);
  const [editIntervalId, setEditIntervalId] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Objective | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<"objectives" | "health" | "alignment">("objectives");
  // #52 — the objective whose work-item links are being edited.
  const [linkTarget, setLinkTarget] = useState<Objective | null>(null);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  /**
   * Objectives live in the SHARED React Query cache, not local state.
   *
   * This board and the Goals / Objectives panel show the same Objective rows,
   * and both can now create them. While this board kept its list in `useState`
   * fed by a bare `fetch`, a create on either screen was invisible to the other
   * until a reload — two boards, one record, two answers. Reading and writing
   * `useOrgQueryKey("objectives", projectId)` — the key the panel already
   * used — makes both surfaces one cache entry, so either screen's write shows
   * up on the other immediately.
   */
  const queryClient = useQueryClient();
  const objectivesKey = useOrgQueryKey("objectives", projectId);
  const intervalsKey = useOrgQueryKey("intervals", projectId);

  const {
    data: objectives = [],
    isLoading: loading,
    isError,
  } = useQuery({
    queryKey: objectivesKey,
    queryFn: () => jsonFetch<Objective[]>(`${basePath}/objectives`),
  });
  const error = isError ? "Failed to load objectives" : null;

  // Intervals for the timebox picker, on the key the panel already reads.
  // SPRINT_READ can be denied independently of OKR_READ, so a failure just
  // leaves the picker empty rather than breaking the board — an objective
  // simply stays untimeboxed.
  const { data: intervals = [] } = useQuery({
    queryKey: intervalsKey,
    queryFn: () => jsonFetch<{ id: string; name: string }[]>(`${basePath}/intervals`),
    retry: false,
  });

  // Drop-in for the old `setObjectives`, writing straight into the shared cache
  // so the optimistic reorder and its rollback keep working unchanged. Plain
  // functions, not `useCallback` — nothing here is memoized, and a stable
  // identity would have to be keyed on the query key, which is a fresh array
  // every render.
  function setObjectives(
    next: Objective[] | ((prev: Objective[]) => Objective[]),
  ) {
    queryClient.setQueryData<Objective[]>(objectivesKey, (prev) =>
      typeof next === "function" ? next(prev ?? []) : next,
    );
  }

  function reload() {
    void queryClient.invalidateQueries({ queryKey: objectivesKey });
  }

  async function handleAddObjective() {
    if (!newTitle.trim()) return;
    setAdding(true);

    try {
      const res = await fetch(`${basePath}/objectives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          status: "ACTIVE",
          committed: newCommitted,
          ...(newIntervalId ? { intervalId: newIntervalId } : {}),
        }),
      });

      if (!res.ok) throw new Error("Failed to create objective");

      const created: Objective = await res.json();
      setObjectives((prev) => [...prev, created]);
      setNewTitle("");
      setShowAddForm(false);
    } catch (err) {
      console.error("Failed to create objective:", err);
      notifyError(err, "Couldn't create the objective.");
    } finally {
      setAdding(false);
    }
  }

  async function handleAddKeyResult(objectiveId: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;

    try {
      const res = await fetch(
        `${basePath}/objectives/${objectiveId}/key-results`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed }),
        }
      );

      if (!res.ok) throw new Error("Failed to create key result");

      const createdKr: KeyResult = await res.json();

      setObjectives((prev) =>
        prev.map((obj) =>
          obj.id === objectiveId
            ? { ...obj, keyResults: [...(obj.keyResults ?? []), createdKr] }
            : obj
        )
      );
    } catch (err) {
      console.error("Failed to create key result:", err);
      notifyError(err, "Couldn't create the key result.");
    }
  }

  async function handleUpdateKeyResult(krId: string, currentValue: number) {
    try {
      const res = await fetch(`${basePath}/key-results/${krId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentValue }),
      });

      if (!res.ok) throw new Error("Failed to update key result");

      const updated = await res.json();

      setObjectives((prev) =>
        prev.map((obj) => ({
          ...obj,
          keyResults: obj.keyResults?.map((kr) =>
            kr.id === krId ? { ...kr, currentValue: updated.currentValue } : kr
          ),
        }))
      );
    } catch (err) {
      console.error("Failed to update key result:", err);
      notifyError(err, "Couldn't update the key result.");
    }
  }

  async function handleReorderObjectives(oldIndex: number, newIndex: number) {
    const previous = objectives;
    const next = arrayMove(objectives, oldIndex, newIndex);
    setObjectives(next); // optimistic
    try {
      const res = await fetch(`${basePath}/objectives`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: next.map((o) => o.id) }),
      });
      if (!res.ok) throw new Error("Failed to reorder objectives");
    } catch (err) {
      setObjectives(previous); // rollback on failure
      console.error("Failed to reorder objectives:", err);
      notifyError(err, "Couldn't save the new order.");
    }
  }

  function handleEdit(objective: Objective) {
    setEditObjective(objective);
    setEditTitle(objective.title);
    setEditDescription(objective.description ?? "");
    setEditPeriod(objective.period ?? "");
    setEditParentId(objective.parentId ?? "");
    setEditCommitted(objective.committed ?? true);
    setEditIntervalId(objective.intervalId ?? "");
  }

  async function handleSaveEdit() {
    if (!editObjective || !editTitle.trim()) return;
    setSaving(true);

    try {
      const res = await fetch(`${basePath}/objectives/${editObjective.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDescription.trim() || null,
          period: editPeriod.trim() || null,
          parentId: editParentId || null,
          committed: editCommitted,
          intervalId: editIntervalId || null,
        }),
      });

      if (!res.ok) throw new Error("Failed to update objective");

      const updated: Objective = await res.json();
      setObjectives((prev) =>
        prev.map((o) =>
          o.id === updated.id ? { ...o, ...updated } : o
        )
      );
      setEditObjective(null);
    } catch (err) {
      console.error("Failed to update objective:", err);
      notifyError(err, "Couldn't update the objective.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    const objectiveId = deleteTarget?.id;
    if (!objectiveId) return;
    setDeleting(true);
    try {
      const res = await fetch(`${basePath}/objectives/${objectiveId}`, {
        method: "DELETE",
      });

      if (!res.ok) throw new Error("Failed to delete objective");

      setObjectives((prev) => prev.filter((o) => o.id !== objectiveId));
      setDeleteTarget(null);
    } catch (err) {
      console.error("Failed to delete objective:", err);
      notifyError(err, "Couldn't delete the objective.");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return <OkrBoardSkeleton />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-sm text-destructive mb-2">
            Failed to load OKRs
          </p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-4 py-2">
        {(["objectives", "health", "alignment"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cn(
              "rounded-md px-3 py-1 text-sm capitalize transition-colors",
              view === v
                ? "bg-[var(--primary)] text-white"
                : "text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            {v}
          </button>
        ))}
      </div>

      {view === "health" ? (
        <div className="flex-1 overflow-auto">
          <OkrHealthView orgId={orgId} projectId={projectId} objectives={objectives} />
        </div>
      ) : view === "alignment" ? (
        <div className="flex-1 overflow-auto">
          <OkrAlignmentView orgId={orgId} objectives={objectives} />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <div className="mx-auto max-w-3xl space-y-3">
      {objectives.length === 0 && !showAddForm && (
        <div className="text-center py-16 border rounded-lg border-dashed">
          <Target className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" />
          <h2 className="text-lg font-medium">No objectives yet</h2>
          <p className="text-sm text-muted-foreground mt-1 mb-4">
            Create your first objective to start tracking OKRs.
          </p>
          <Button onClick={() => setShowAddForm(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            Add Objective
          </Button>
        </div>
      )}

      {objectives.length > 0 && (
        <OkrObjectivesView
          orgId={orgId}
          projectId={projectId}
          objectives={objectives}
          onUpdateKeyResult={handleUpdateKeyResult}
          onAddKeyResult={handleAddKeyResult}
          onEdit={handleEdit}
          onDelete={(id: string) =>
            setDeleteTarget(objectives.find((o) => o.id === id) ?? null)
          }
          onLinkItems={(o: Objective) => setLinkTarget(o)}
          onCheckedIn={reload}
          onReorder={handleReorderObjectives}
        />
      )}

      {showAddForm ? (
        <div className="space-y-2 p-3 rounded-lg border border-dashed">
        <div className="flex items-center gap-2">
          <Input
            placeholder="Objective title..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddObjective();
              if (e.key === "Escape") {
                setShowAddForm(false);
                setNewTitle("");
              }
            }}
            autoFocus
          />
          <Button onClick={handleAddObjective} disabled={adding || !newTitle.trim()}>
            {adding ? "Adding..." : "Add"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setShowAddForm(false);
              setNewTitle("");
            }}
          >
            Cancel
          </Button>
        </div>
        {/* The two fields the schema gained in 2.247.0. Optional: an objective
            with neither is an ordinary, committed, untimeboxed one. */}
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Interval"
            value={newIntervalId}
            onChange={(e) => setNewIntervalId(e.target.value)}
            className="h-8 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-xs"
          >
            <option value="">— Not in an interval —</option>
            {intervals.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              className="accent-[var(--primary)]"
              checked={!newCommitted}
              onChange={(e) => setNewCommitted(!e.target.checked)}
            />
            Uncommitted (stretch)
          </label>
        </div>
        </div>
      ) : (
        objectives.length > 0 && (
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={() => setShowAddForm(true)}
          >
            <Plus className="h-4 w-4" />
            Add Objective
          </Button>
        )
      )}
          </div>
        </div>
      )}

      <Dialog
        open={editObjective !== null}
        onOpenChange={(open) => {
          if (!open) setEditObjective(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit objective</DialogTitle>
            <DialogDescription>
              Update the title, description, and period for this objective.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="objective-title">Title</Label>
              <Input
                id="objective-title"
                placeholder="Objective title..."
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="objective-description">Description</Label>
              <Textarea
                id="objective-description"
                placeholder="What does success look like?"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="objective-period">Period</Label>
              <Input
                id="objective-period"
                placeholder="e.g. Q2 2026"
                value={editPeriod}
                onChange={(e) => setEditPeriod(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="objective-parent">Aligns to (parent objective)</Label>
              <select
                id="objective-parent"
                value={editParentId}
                onChange={(e) => setEditParentId(e.target.value)}
                className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-sm"
              >
                <option value="">— None (top-level) —</option>
                {objectives
                  .filter((o) => o.id !== editObjective?.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.title}
                    </option>
                  ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="objective-interval">Interval (PI or sprint)</Label>
              <select
                id="objective-interval"
                value={editIntervalId}
                onChange={(e) => setEditIntervalId(e.target.value)}
                className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-sm"
              >
                <option value="">— Not in an interval —</option>
                {intervals.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--primary)]"
                checked={!editCommitted}
                onChange={(e) => setEditCommitted(!e.target.checked)}
              />
              <span>
                Uncommitted (stretch)
                <span className="block text-xs text-muted-foreground">
                  Planned for, but not promised — excluded from what the interval is
                  accountable for.
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditObjective(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveEdit}
              disabled={saving || !editTitle.trim()}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* #52 — the work items an objective is delivered by. */}
      {linkTarget && (
        <ObjectiveLinksDialog
          orgId={orgId}
          projectId={projectId}
          objectiveId={linkTarget.id}
          objectiveTitle={linkTarget.title}
          open
          onOpenChange={(o) => {
            if (!o) setLinkTarget(null);
          }}
          onChanged={reload}
        />
      )}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete objective?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              {deleteTarget?.title ? `"${deleteTarget.title}"` : "this objective"}{" "}
              and its key results. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OkrBoardSkeleton() {
  return (
    <div className="p-4 max-w-3xl mx-auto space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-16" />
          </div>
          <Skeleton className="h-1.5 w-full max-w-xs" />
        </div>
      ))}
    </div>
  );
}
