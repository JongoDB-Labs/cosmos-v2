"use client";

import { useState, useEffect } from "react";
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
import { ObjectiveCard } from "./objective-card";
import { notifyError } from "@/lib/errors/notify";
import type { Objective, KeyResult } from "@/types/models";

interface OkrBoardProps {
  orgId: string;
  projectId: string;
}

export function OkrBoard({ orgId, projectId }: OkrBoardProps) {
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);

  const [editObjective, setEditObjective] = useState<Objective | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPeriod, setEditPeriod] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Objective | null>(null);
  const [deleting, setDeleting] = useState(false);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  useEffect(() => {
    let cancelled = false;

    async function fetchObjectives() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`${basePath}/objectives`);
        if (!res.ok) throw new Error("Failed to load objectives");
        const data: Objective[] = await res.json();
        if (!cancelled) setObjectives(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchObjectives();
    return () => {
      cancelled = true;
    };
  }, [basePath]);

  async function handleAddObjective() {
    if (!newTitle.trim()) return;
    setAdding(true);

    try {
      const res = await fetch(`${basePath}/objectives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim(), status: "ACTIVE" }),
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

  function handleEdit(objective: Objective) {
    setEditObjective(objective);
    setEditTitle(objective.title);
    setEditDescription(objective.description ?? "");
    setEditPeriod(objective.period ?? "");
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
    <div className="p-4 max-w-3xl mx-auto space-y-3">
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

      {objectives.map((objective) => (
        <ObjectiveCard
          key={objective.id}
          objective={objective}
          onUpdateKeyResult={handleUpdateKeyResult}
          onAddKeyResult={handleAddKeyResult}
          onEdit={handleEdit}
          onDelete={(id: string) =>
            setDeleteTarget(objectives.find((o) => o.id === id) ?? null)
          }
        />
      ))}

      {showAddForm ? (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-dashed">
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
