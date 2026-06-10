"use client";

import { useState, useEffect, useCallback } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  usePermissions,
  Permission,
} from "@/components/providers/permissions-provider";
import { notifyError } from "@/lib/errors/notify";
import {
  IterationCcw,
  Plus,
  Play,
  CheckCircle2,
  Trash2,
  Target,
  Users,
} from "lucide-react";
import { CapacityDialog } from "./capacity-dialog";

interface CycleReport {
  velocity?: number;
  completedItems?: number;
  incompleteItems?: number;
  completedStoryPoints?: number;
  totalItems?: number;
  completedAt?: string;
}

interface Cycle {
  id: string;
  number: number;
  name: string;
  goal: string | null;
  startDate: string;
  endDate: string;
  status: "PLANNED" | "ACTIVE" | "COMPLETED";
  cycleKind: string;
  report: CycleReport | null;
  _count?: { workItems: number };
}

const KIND_LABELS: Record<string, string> = {
  SPRINT: "Sprint",
  PHASE: "Phase",
  MODULE: "Module",
  RUN: "Run",
  EVENT_DAY: "Event Day",
  RELEASE: "Release",
  ITERATION: "Iteration",
};

// Sentinel for the "Backlog (no cycle)" option — base-ui Select treats an empty
// string as "unset" and would show the placeholder instead of the label.
const BACKLOG_OPTION = "__backlog__";

const STATUS_GROUPS: { status: Cycle["status"]; label: string }[] = [
  { status: "ACTIVE", label: "Active" },
  { status: "PLANNED", label: "Planned" },
  { status: "COMPLETED", label: "Completed" },
];

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface CyclesWorkspaceProps {
  orgId: string;
  projectId: string;
}

export function CyclesWorkspace({ orgId, projectId }: CyclesWorkspaceProps) {
  const { can } = usePermissions();
  const canCreate = can(Permission.SPRINT_CREATE);
  const canUpdate = can(Permission.SPRINT_UPDATE);
  const canComplete = can(Permission.SPRINT_COMPLETE);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create dialog state.
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [kind, setKind] = useState("SPRINT");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Delete confirmation.
  const [deleteTarget, setDeleteTarget] = useState<Cycle | null>(null);

  // Capacity planning dialog.
  const [capacityTarget, setCapacityTarget] = useState<Cycle | null>(null);

  // Sprint-review / completion dialog: which cycle is being completed, and where
  // its incomplete items should go (BACKLOG sentinel, else a planned cycle id).
  const [completeTarget, setCompleteTarget] = useState<Cycle | null>(null);
  const [moveToCycleId, setMoveToCycleId] = useState<string>(BACKLOG_OPTION);

  const fetchCycles = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`${basePath}/cycles`);
      if (!res.ok) throw new Error("Failed to load cycles");
      setCycles(await res.json());
    } catch (err) {
      notifyError(err, "Couldn't load cycles.");
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  // Initial + post-mutation load. Streaming state from inside the effect is the
  // intended pattern here (same as command-palette / okr-board).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    fetchCycles();
  }, [fetchCycles]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function createCycle() {
    if (!name.trim() || !startDate || !endDate) return;
    if (new Date(endDate) < new Date(startDate)) {
      notifyError(
        new Error("End before start"),
        "End date must be on or after the start date.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${basePath}/cycles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          goal: goal.trim() || null,
          startDate: new Date(startDate).toISOString(),
          endDate: new Date(endDate).toISOString(),
          cycleKind: kind,
        }),
      });
      if (!res.ok) throw new Error("Failed to create cycle");
      setOpen(false);
      setName("");
      setGoal("");
      setKind("SPRINT");
      setStartDate("");
      setEndDate("");
      await fetchCycles();
    } catch (err) {
      notifyError(err, "Couldn't create the cycle.");
    } finally {
      setSubmitting(false);
    }
  }

  async function activateCycle(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`${basePath}/cycles/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ACTIVE" }),
      });
      if (res.status === 409)
        throw new Error("Another cycle is already active — complete it first.");
      if (!res.ok) throw new Error("Failed to start cycle");
      await fetchCycles();
    } catch (err) {
      notifyError(
        err,
        err instanceof Error ? err.message : "Couldn't start the cycle.",
      );
    } finally {
      setBusyId(null);
    }
  }

  // moveIncompleteToCycleId: null → incomplete items return to the backlog;
  // a cycle id → they roll over into that (planned) cycle.
  async function completeCycle(id: string, moveIncompleteToCycleId: string | null) {
    setBusyId(id);
    try {
      const res = await fetch(`${basePath}/cycles/${id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moveIncompleteToCycleId }),
      });
      if (!res.ok) throw new Error("Failed to complete cycle");
      setCompleteTarget(null);
      await fetchCycles();
    } catch (err) {
      notifyError(err, "Couldn't complete the cycle.");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setBusyId(id);
    try {
      const res = await fetch(`${basePath}/cycles/${id}`, { method: "DELETE" });
      if (res.status === 409)
        throw new Error("Active cycles can't be deleted — complete it first.");
      if (!res.ok) throw new Error("Failed to delete cycle");
      setDeleteTarget(null);
      await fetchCycles();
    } catch (err) {
      notifyError(
        err,
        err instanceof Error ? err.message : "Couldn't delete the cycle.",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl p-8 space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">Couldn&apos;t load cycles.</p>
          <Button variant="outline" size="sm" onClick={fetchCycles}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Cycles</h2>
          <p className="text-sm text-muted-foreground">
            Plan and track sprints, phases, and iterations.
          </p>
        </div>
        {canCreate && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New cycle
          </Button>
        )}
      </div>

      {cycles.length === 0 ? (
        <EmptyState
          illustration={<IterationCcw className="size-10" />}
          title="No cycles yet"
          description={
            canCreate
              ? "Create your first cycle to start planning work into time-boxed iterations."
              : "No cycles have been created for this project yet."
          }
        />
      ) : (
        <div className="space-y-8">
          {STATUS_GROUPS.map(({ status, label }) => {
            const group = cycles.filter((c) => c.status === status);
            if (group.length === 0) return null;
            return (
              <section key={status} className="space-y-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {label} ({group.length})
                </h3>
                <div className="space-y-3">
                  {group.map((cycle) => (
                    <CycleCard
                      key={cycle.id}
                      cycle={cycle}
                      busy={busyId === cycle.id}
                      canUpdate={canUpdate}
                      canComplete={canComplete}
                      onStart={() => activateCycle(cycle.id)}
                      onComplete={() => {
                        setMoveToCycleId(BACKLOG_OPTION);
                        setCompleteTarget(cycle);
                      }}
                      onDelete={() => setDeleteTarget(cycle)}
                      onCapacity={() => setCapacityTarget(cycle)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Plan a cycle</DialogTitle>
            <DialogDescription>
              A time-boxed iteration (sprint, phase, release…) to group and track
              work.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cycle-name">Name</Label>
              <Input
                id="cycle-name"
                placeholder="e.g. Sprint 12"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cycle-kind">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v ?? "SPRINT")}>
                <SelectTrigger id="cycle-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(KIND_LABELS).map(([value, lbl]) => (
                    <SelectItem key={value} value={value}>
                      {lbl}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cycle-start">Start date</Label>
                <Input
                  id="cycle-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cycle-end">End date</Label>
                <Input
                  id="cycle-end"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cycle-goal">Goal (optional)</Label>
              <Input
                id="cycle-goal"
                placeholder="What should this cycle achieve?"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={createCycle}
              disabled={submitting || !name.trim() || !startDate || !endDate}
            >
              {submitting ? "Creating…" : "Create cycle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this cycle?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <span className="font-medium">{deleteTarget?.name}</span>. Work
              items stay in the project. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Capacity planning */}
      {capacityTarget && (
        <CapacityDialog
          orgId={orgId}
          projectId={projectId}
          cycleId={capacityTarget.id}
          cycleName={capacityTarget.name}
          canEdit={canUpdate}
          onClose={() => setCapacityTarget(null)}
        />
      )}

      {/* Sprint review / completion — choose where incomplete items go. */}
      <Dialog
        open={completeTarget !== null}
        onOpenChange={(o) => !o && setCompleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Complete {completeTarget ? completeTarget.name : "cycle"}
            </DialogTitle>
            <DialogDescription>
              Completing locks the cycle and records its velocity. Any unfinished
              work items need a new home — choose where they go.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {completeTarget?._count?.workItems != null && (
              <p className="text-sm text-muted-foreground">
                This cycle has{" "}
                <span className="font-medium text-foreground">
                  {completeTarget._count.workItems}
                </span>{" "}
                item{completeTarget._count.workItems === 1 ? "" : "s"}. Completed
                ones stay; unfinished ones move below.
              </p>
            )}
            <div className="space-y-1.5">
              <Label>Move unfinished items to</Label>
              <Select
                value={moveToCycleId}
                onValueChange={(v) => setMoveToCycleId(v ?? BACKLOG_OPTION)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Backlog" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BACKLOG_OPTION}>Backlog (no cycle)</SelectItem>
                  {cycles
                    .filter(
                      (c) =>
                        c.status === "PLANNED" && c.id !== completeTarget?.id,
                    )
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCompleteTarget(null)}
              disabled={busyId === completeTarget?.id}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                completeTarget &&
                completeCycle(
                  completeTarget.id,
                  moveToCycleId === BACKLOG_OPTION ? null : moveToCycleId,
                )
              }
              disabled={busyId === completeTarget?.id}
            >
              {busyId === completeTarget?.id ? "Completing…" : "Complete cycle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface CycleCardProps {
  cycle: Cycle;
  busy: boolean;
  canUpdate: boolean;
  canComplete: boolean;
  onStart: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onCapacity: () => void;
}

function CycleCard({
  cycle,
  busy,
  canUpdate,
  canComplete,
  onStart,
  onComplete,
  onDelete,
  onCapacity,
}: CycleCardProps) {
  const itemCount = cycle._count?.workItems ?? 0;
  const report = cycle.report;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-sm truncate">
              {cycle.name}
            </h4>
            <Badge variant="neutral" className="shrink-0 text-[10px]">
              {KIND_LABELS[cycle.cycleKind] ?? cycle.cycleKind} #{cycle.number}
            </Badge>
            {cycle.status === "ACTIVE" && (
              <Badge variant="progress" className="shrink-0 text-[10px]">
                Active
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {fmtDate(cycle.startDate)} – {fmtDate(cycle.endDate)} · {itemCount}{" "}
            {itemCount === 1 ? "item" : "items"}
          </p>
          {cycle.goal && (
            <p className="text-xs text-muted-foreground mt-2 flex items-start gap-1">
              <Target className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>{cycle.goal}</span>
            </p>
          )}
          {cycle.status === "COMPLETED" && report && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                Velocity:{" "}
                <span className="font-medium text-foreground">
                  {report.velocity ?? report.completedStoryPoints ?? 0} pts
                </span>
              </span>
              <span>
                Completed:{" "}
                <span className="font-medium text-foreground">
                  {report.completedItems ?? 0}
                </span>
              </span>
              <span>
                Carried over:{" "}
                <span className="font-medium text-foreground">
                  {report.incompleteItems ?? 0}
                </span>
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {cycle.status === "PLANNED" && canUpdate && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onStart}
            >
              <Play className="h-3.5 w-3.5 mr-1" />
              Start
            </Button>
          )}
          {cycle.status === "ACTIVE" && canComplete && (
            <Button size="sm" disabled={busy} onClick={onComplete}>
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              Complete
            </Button>
          )}
          {cycle.status !== "COMPLETED" && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Plan capacity"
              title="Capacity"
              onClick={onCapacity}
            >
              <Users className="h-3.5 w-3.5" />
            </Button>
          )}
          {cycle.status !== "ACTIVE" && canUpdate && (
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              aria-label="Delete cycle"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
