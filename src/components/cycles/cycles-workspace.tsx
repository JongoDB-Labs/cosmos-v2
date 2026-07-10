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
import { cn } from "@/lib/utils";
import {
  IterationCcw,
  Plus,
  Play,
  CheckCircle2,
  Trash2,
  Pencil,
  Target,
  Users,
  ListPlus,
  Gauge,
} from "lucide-react";
import { CapacityDialog } from "./capacity-dialog";
import { AddIssuesDialog } from "./add-issues-dialog";
import { PlanSprintDialog } from "./plan-sprint-dialog";
import {
  computeSprintMetrics,
  suggestNextSprint,
  type SprintMetrics,
} from "@/lib/cycles/sprint-metrics";

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
  /** Program Increment this cycle is nested under (a PI cycle id), or null. */
  parentId: string | null;
  report: CycleReport | null;
  _count?: { workItems: number };
}

const PI_KIND = "PROGRAM_INCREMENT";

const KIND_LABELS: Record<string, string> = {
  SPRINT: "Sprint",
  PHASE: "Phase",
  MODULE: "Module",
  RUN: "Run",
  EVENT_DAY: "Event Day",
  RELEASE: "Release",
  ITERATION: "Iteration",
  PROGRAM_INCREMENT: "Program Increment",
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
  projectKey: string;
}

export function CyclesWorkspace({ orgId, projectId, projectKey }: CyclesWorkspaceProps) {
  const { can } = usePermissions();
  const canCreate = can(Permission.SPRINT_CREATE);
  const canUpdate = can(Permission.SPRINT_UPDATE);
  const canComplete = can(Permission.SPRINT_COMPLETE);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create/edit dialog state. editId != null → the dialog edits that cycle.
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
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

  // Sprint-planning flow (opened when starting a planned sprint).
  const [planTarget, setPlanTarget] = useState<Cycle | null>(null);

  // Roll-over prompt shown after a sprint completes, pre-filled with the next
  // iteration (incremented title + same duration). Dates are YYYY-MM-DD for the
  // <input type=date> controls.
  const [rollover, setRollover] = useState<{
    name: string;
    startDate: string;
    endDate: string;
    cycleKind: string;
    parentId: string | null;
  } | null>(null);
  const [rolloverBusy, setRolloverBusy] = useState(false);

  // "Add issues to this cycle" picker (FR 0e31d1ef).
  const [addIssuesTarget, setAddIssuesTarget] = useState<Cycle | null>(null);
  // cycleId → name, for the "currently in X" badge in the picker.
  const cycleNames = Object.fromEntries(cycles.map((c) => [c.id, c.name]));

  // Program Increments (top-level PI cycles) — used both to render the PI
  // grouping and to populate each sprint's "Move to PI" selector.
  const pis = cycles.filter((c) => c.cycleKind === PI_KIND);
  // Shared CycleCard wiring so the PI section and the status groups render
  // identical cards (a sprint may appear in either place).
  const cardProps = (cycle: Cycle): CycleCardProps => ({
    cycle,
    busy: busyId === cycle.id,
    canUpdate,
    canComplete,
    pis,
    onStart: () => setPlanTarget(cycle),
    onComplete: () => {
      setMoveToCycleId(BACKLOG_OPTION);
      setCompleteTarget(cycle);
    },
    onEdit: () => openEdit(cycle),
    onDelete: () => setDeleteTarget(cycle),
    onCapacity: () => setCapacityTarget(cycle),
    onAddIssues: () => setAddIssuesTarget(cycle),
    onAssignPI: (parentId: string | null) => assignToPI(cycle.id, parentId),
  });

  // Sprint-review / completion dialog: which cycle is being completed, and where
  // its incomplete items should go (BACKLOG sentinel, else a planned cycle id).
  const [completeTarget, setCompleteTarget] = useState<Cycle | null>(null);
  const [moveToCycleId, setMoveToCycleId] = useState<string>(BACKLOG_OPTION);

  // Live retrospective metrics for the sprint-review step of the complete dialog.
  const [reviewMetrics, setReviewMetrics] = useState<SprintMetrics | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);

  // When a cycle is queued for completion, fetch its items and compute the
  // review metrics the user sees BEFORE finalizing (burn rate, pacing,
  // efficiency). Uses the same shared helper the server persists on completion.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!completeTarget) {
      setReviewMetrics(null);
      return;
    }
    let cancelled = false;
    setReviewLoading(true);
    setReviewMetrics(null);
    (async () => {
      try {
        const res = await fetch(`${basePath}/cycles/${completeTarget.id}`);
        if (!res.ok) throw new Error("Failed to load sprint review");
        const data: {
          workItems?: { storyPoints: number | null; columnKey: string; priority?: string | null }[];
        } = await res.json();
        const metrics = computeSprintMetrics({
          items: data.workItems ?? [],
          startDate: completeTarget.startDate,
          endDate: completeTarget.endDate,
        });
        if (!cancelled) setReviewMetrics(metrics);
      } catch {
        // Non-fatal — the dialog still lets the user complete without metrics.
        if (!cancelled) setReviewMetrics(null);
      } finally {
        if (!cancelled) setReviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [completeTarget, basePath]);
  /* eslint-enable react-hooks/set-state-in-effect */

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

  function resetForm() {
    setEditId(null);
    setName("");
    setGoal("");
    setKind("SPRINT");
    setStartDate("");
    setEndDate("");
  }

  // Open the dialog pre-filled to EDIT an existing cycle (FR: "edit/delete a
  // sprint after the fact"). Dates come back as ISO; the date input wants
  // YYYY-MM-DD.
  function openEdit(cycle: Cycle) {
    setEditId(cycle.id);
    setName(cycle.name);
    setGoal(cycle.goal ?? "");
    setStartDate(cycle.startDate ? cycle.startDate.slice(0, 10) : "");
    setEndDate(cycle.endDate ? cycle.endDate.slice(0, 10) : "");
    setOpen(true);
  }

  async function submitCycle() {
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
      // Editing PUTs name/goal/dates (kind is fixed after creation); creating
      // POSTs the full new cycle.
      const res = editId
        ? await fetch(`${basePath}/cycles/${editId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: name.trim(),
              goal: goal.trim() || null,
              startDate: new Date(startDate).toISOString(),
              endDate: new Date(endDate).toISOString(),
            }),
          })
        : await fetch(`${basePath}/cycles`, {
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
      if (!res.ok) throw new Error("Failed to save cycle");
      setOpen(false);
      resetForm();
      await fetchCycles();
    } catch (err) {
      notifyError(err, editId ? "Couldn't update the cycle." : "Couldn't create the cycle.");
    } finally {
      setSubmitting(false);
    }
  }

  // Nest a sprint under a Program Increment (parentId = PI id), or detach it
  // (parentId = null) back to the top level.
  async function assignToPI(id: string, parentId: string | null) {
    setBusyId(id);
    try {
      const res = await fetch(`${basePath}/cycles/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId }),
      });
      if (!res.ok) throw new Error("Failed to update the Program Increment");
      await fetchCycles();
    } catch (err) {
      notifyError(err, "Couldn't move the sprint to that Program Increment.");
    } finally {
      setBusyId(null);
    }
  }

  // moveIncompleteToCycleId: null → incomplete items return to the backlog;
  // a cycle id → they roll over into that (planned) cycle.
  async function completeCycle(cycle: Cycle, moveIncompleteToCycleId: string | null) {
    setBusyId(cycle.id);
    try {
      const res = await fetch(`${basePath}/cycles/${cycle.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moveIncompleteToCycleId }),
      });
      if (!res.ok) throw new Error("Failed to complete cycle");
      setCompleteTarget(null);
      await fetchCycles();
      // Prompt to auto-start the next iteration, pre-filled with an incremented
      // title + the same duration (only for time-boxed cycles, not PIs).
      if (cycle.cycleKind !== PI_KIND) {
        const next = suggestNextSprint(cycle);
        setRollover({
          name: next.name,
          startDate: next.startDate.slice(0, 10),
          endDate: next.endDate.slice(0, 10),
          cycleKind: next.cycleKind,
          parentId: next.parentId,
        });
      }
    } catch (err) {
      notifyError(err, "Couldn't complete the cycle.");
    } finally {
      setBusyId(null);
    }
  }

  // Create the pre-filled next sprint from the roll-over prompt, then hand off to
  // the planning flow so the user can review capacity and start it.
  async function createNextSprint() {
    if (!rollover) return;
    if (!rollover.name.trim() || !rollover.startDate || !rollover.endDate) return;
    if (new Date(rollover.endDate) < new Date(rollover.startDate)) {
      notifyError(
        new Error("End before start"),
        "End date must be on or after the start date.",
      );
      return;
    }
    setRolloverBusy(true);
    try {
      const res = await fetch(`${basePath}/cycles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: rollover.name.trim(),
          startDate: new Date(rollover.startDate).toISOString(),
          endDate: new Date(rollover.endDate).toISOString(),
          cycleKind: rollover.cycleKind,
          parentId: rollover.parentId,
        }),
      });
      if (!res.ok) throw new Error("Failed to create the next sprint");
      const createdCycle: Cycle = await res.json();
      setRollover(null);
      await fetchCycles();
      // Chain into the planning flow for the freshly created sprint.
      setPlanTarget(createdCycle);
    } catch (err) {
      notifyError(err, "Couldn't create the next sprint.");
    } finally {
      setRolloverBusy(false);
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
          {/* Program Increments (SAFe): each PI groups its child sprints. */}
          {pis.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Program Increments ({pis.length})
              </h3>
              <div className="space-y-4">
                {pis.map((pi) => {
                  const children = cycles.filter((c) => c.parentId === pi.id);
                  return (
                    <div
                      key={pi.id}
                      className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
                    >
                      <CycleCard {...cardProps(pi)} />
                      <div className="ml-3 space-y-2 border-l-2 border-primary/20 pl-3">
                        {children.length === 0 ? (
                          <p className="py-1 text-xs text-muted-foreground">
                            No sprints in this PI yet — use “Move to PI” on a sprint below.
                          </p>
                        ) : (
                          children.map((child) => <CycleCard key={child.id} {...cardProps(child)} />)
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {STATUS_GROUPS.map(({ status, label }) => {
            // Sprints nested in a PI show under that PI above; here we list the
            // top-level cycles (not PIs, not already grouped under a PI).
            const group = cycles.filter(
              (c) => c.status === status && c.cycleKind !== PI_KIND && c.parentId == null,
            );
            if (group.length === 0) return null;
            return (
              <section key={status} className="space-y-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {label} ({group.length})
                </h3>
                <div className="space-y-3">
                  {group.map((cycle) => (
                    <CycleCard key={cycle.id} {...cardProps(cycle)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) resetForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? "Edit cycle" : "Plan a cycle"}</DialogTitle>
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
            {!editId && (
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
            )}
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
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={submitCycle}
              disabled={submitting || !name.trim() || !startDate || !endDate}
            >
              {submitting
                ? editId
                  ? "Saving…"
                  : "Creating…"
                : editId
                  ? "Save changes"
                  : "Create cycle"}
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

      {/* Sprint-planning flow — opened when starting a planned sprint. */}
      {planTarget && (
        <PlanSprintDialog
          orgId={orgId}
          projectId={projectId}
          cycle={planTarget}
          onClose={() => setPlanTarget(null)}
          onStarted={fetchCycles}
        />
      )}

      {/* Roll-over prompt: auto-start the next sprint after one completes. */}
      <Dialog open={rollover !== null} onOpenChange={(o) => !o && setRollover(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start the next sprint?</DialogTitle>
            <DialogDescription>
              Sprint complete 🎉 We&apos;ve pre-filled the next iteration with the
              same duration. Adjust it, then plan &amp; start.
            </DialogDescription>
          </DialogHeader>
          {rollover && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="rollover-name">Name</Label>
                <Input
                  id="rollover-name"
                  value={rollover.name}
                  onChange={(e) =>
                    setRollover((r) => (r ? { ...r, name: e.target.value } : r))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="rollover-start">Start date</Label>
                  <Input
                    id="rollover-start"
                    type="date"
                    value={rollover.startDate}
                    onChange={(e) =>
                      setRollover((r) => (r ? { ...r, startDate: e.target.value } : r))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rollover-end">End date</Label>
                  <Input
                    id="rollover-end"
                    type="date"
                    value={rollover.endDate}
                    onChange={(e) =>
                      setRollover((r) => (r ? { ...r, endDate: e.target.value } : r))
                    }
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRollover(null)}
              disabled={rolloverBusy}
            >
              Not now
            </Button>
            <Button
              onClick={createNextSprint}
              disabled={
                rolloverBusy ||
                !rollover?.name.trim() ||
                !rollover?.startDate ||
                !rollover?.endDate
              }
            >
              {rolloverBusy ? "Creating…" : "Plan next sprint"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add issues to a cycle (FR 0e31d1ef) — bulk-move project issues in. */}
      <AddIssuesDialog
        orgId={orgId}
        projectId={projectId}
        projectKey={projectKey}
        cycle={addIssuesTarget}
        open={addIssuesTarget !== null}
        onOpenChange={(o) => !o && setAddIssuesTarget(null)}
        onAdded={fetchCycles}
        cycleNames={cycleNames}
      />

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
              Review the sprint&apos;s retrospective metrics, then choose where
              any unfinished work goes. Completing locks the sprint and records
              its report.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <SprintReviewPanel metrics={reviewMetrics} loading={reviewLoading} />
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
                  completeTarget,
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
  /** Available Program Increments, for the "Move to PI" selector. */
  pis: Cycle[];
  onStart: () => void;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCapacity: () => void;
  onAddIssues: () => void;
  onAssignPI: (parentId: string | null) => void;
}

// Select sentinel for "not in any PI" (base-ui Select can't use "").
const NO_PI = "__no_pi__";

function CycleCard({
  cycle,
  busy,
  canUpdate,
  canComplete,
  pis,
  onStart,
  onComplete,
  onEdit,
  onDelete,
  onCapacity,
  onAddIssues,
  onAssignPI,
}: CycleCardProps) {
  const itemCount = cycle._count?.workItems ?? 0;
  const report = cycle.report;
  const isPI = cycle.cycleKind === PI_KIND;
  // A sprint (non-PI, non-completed) can be nested under a PI, if any exist.
  const showPISelect =
    !isPI && canUpdate && cycle.status !== "COMPLETED" && pis.length > 0;

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
          {showPISelect && (
            <div className="mt-2 flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">PI:</span>
              <Select
                value={cycle.parentId ?? NO_PI}
                onValueChange={(v) => onAssignPI(v === NO_PI ? null : (v as string))}
              >
                <SelectTrigger size="sm" className="h-6 w-auto min-w-[8rem] text-xs" disabled={busy}>
                  <SelectValue placeholder="No PI" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PI}>No PI</SelectItem>
                  {pis.map((pi) => (
                    <SelectItem key={pi.id} value={pi.id}>
                      {pi.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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
          {cycle.status !== "COMPLETED" && canUpdate && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onAddIssues}
            >
              <ListPlus className="h-3.5 w-3.5 mr-1" />
              Add issues
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
          {cycle.status !== "COMPLETED" && canUpdate && (
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              aria-label="Edit cycle"
              title="Edit"
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
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

interface StatProps {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}

function Stat({ label, value, sub, valueClass }: StatProps) {
  return (
    <div>
      <p className={cn("text-sm font-semibold text-foreground", valueClass)}>{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

/**
 * Retrospective metrics shown in the sprint-review step before a sprint is
 * finalized (AC: "burn rate, pacing, and efficiency before finalization").
 * Computed live from the sprint's items via the shared metrics helper.
 */
function SprintReviewPanel({
  metrics,
  loading,
}: {
  metrics: SprintMetrics | null;
  loading: boolean;
}) {
  if (loading) {
    return <Skeleton className="h-28 w-full" />;
  }
  if (!metrics) return null;

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const pacingLabel =
    metrics.pacing === "ahead"
      ? "Ahead"
      : metrics.pacing === "behind"
        ? "Behind"
        : "On track";
  const pacingClass =
    metrics.pacing === "ahead"
      ? "text-emerald-600 dark:text-emerald-500"
      : metrics.pacing === "behind"
        ? "text-amber-600 dark:text-amber-500"
        : "text-foreground";

  return (
    <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Gauge className="h-3.5 w-3.5" /> Sprint review
      </div>
      <div className="grid grid-cols-3 gap-3 text-center">
        <Stat label="Velocity" value={`${metrics.velocity} pts`} />
        <Stat
          label="Efficiency"
          value={pct(metrics.pointCompletionRate)}
          sub={`${metrics.completedStoryPoints}/${metrics.totalStoryPoints} pts`}
        />
        <Stat
          label="Items done"
          value={`${metrics.completedItems}/${metrics.totalItems}`}
          sub={pct(metrics.itemCompletionRate)}
        />
        <Stat label="Burn rate" value={`${metrics.burnRate}`} sub="pts / day" />
        <Stat label="Pacing" value={pacingLabel} valueClass={pacingClass} />
        <Stat label="Carrying over" value={`${metrics.incompleteItems}`} sub="items" />
      </div>
    </div>
  );
}
