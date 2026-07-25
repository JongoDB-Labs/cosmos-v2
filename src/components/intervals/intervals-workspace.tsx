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
  Pencil,
  Target,
  Users,
  ListPlus,
} from "lucide-react";
import { CapacityDialog } from "./capacity-dialog";
import { AddIssuesDialog } from "./add-issues-dialog";
import { StartSprintDialog } from "./start-sprint-dialog";
import { computeSprintReview, type SprintReview } from "@/lib/intervals/sprint-review";
import { computeNextSprintDefaults } from "@/lib/intervals/next-sprint";

interface IntervalReport {
  velocity?: number;
  completedItems?: number;
  incompleteItems?: number;
  completedStoryPoints?: number;
  totalItems?: number;
  completedAt?: string;
}

interface Interval {
  id: string;
  number: number;
  name: string;
  goal: string | null;
  startDate: string;
  endDate: string;
  status: "PLANNED" | "ACTIVE" | "COMPLETED";
  intervalKind: string;
  /** Program Increment this interval is nested under (a PI interval id), or null. */
  parentId: string | null;
  report: IntervalReport | null;
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

// Sentinel for the "Backlog (no interval)" option — base-ui Select treats an empty
// string as "unset" and would show the placeholder instead of the label.
const BACKLOG_OPTION = "__backlog__";

const STATUS_GROUPS: { status: Interval["status"]; label: string }[] = [
  { status: "ACTIVE", label: "Active" },
  { status: "PLANNED", label: "Planned" },
  { status: "COMPLETED", label: "Completed" },
];

function fmtDate(iso: string) {
  // Interval start/end are calendar days stored at UTC midnight; format in UTC so a
  // viewer west of UTC doesn't see the previous day (the off-by-one on cards).
  return new Date(iso).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface IntervalsWorkspaceProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  /** Pre-selected kind for the create form — the project sector's default
   *  (Sprint for software, Phase for AEC, …). Falls back to SPRINT. */
  defaultKind?: string;
}

export function IntervalsWorkspace({ orgId, projectId, projectKey, defaultKind = "SPRINT" }: IntervalsWorkspaceProps) {
  const { can } = usePermissions();
  const canCreate = can(Permission.SPRINT_CREATE);
  const canUpdate = can(Permission.SPRINT_UPDATE);
  const canComplete = can(Permission.SPRINT_COMPLETE);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const [intervals, setIntervals] = useState<Interval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create/edit dialog state. editId != null → the dialog edits that interval.
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [kind, setKind] = useState(defaultKind);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Delete confirmation.
  const [deleteTarget, setDeleteTarget] = useState<Interval | null>(null);

  // Capacity planning dialog.
  const [capacityTarget, setCapacityTarget] = useState<Interval | null>(null);

  // Start Sprint planning flow (sprint-kind intervals only).
  const [startTarget, setStartTarget] = useState<Interval | null>(null);

  // "Add issues to this interval" picker (FR 0e31d1ef).
  const [addIssuesTarget, setAddIssuesTarget] = useState<Interval | null>(null);
  // intervalId → name, for the "currently in X" badge in the picker.
  const intervalNames = Object.fromEntries(intervals.map((c) => [c.id, c.name]));

  // Program Increments (top-level PI intervals) — used both to render the PI
  // grouping and to populate each sprint's "Move to PI" selector.
  const pis = intervals.filter((c) => c.intervalKind === PI_KIND);
  // Shared IntervalCard wiring so the PI section and the status groups render
  // identical cards (a sprint may appear in either place).
  const cardProps = (interval: Interval): IntervalCardProps => ({
    interval,
    busy: busyId === interval.id,
    canUpdate,
    canComplete,
    pis,
    // Sprints launch the planning flow; other interval kinds activate directly.
    onStart: () =>
      interval.intervalKind === "SPRINT" ? setStartTarget(interval) : activateInterval(interval.id),
    onComplete: () => {
      setMoveToIntervalId(BACKLOG_OPTION);
      setCompleteStep("review");
      setCompleteTarget(interval);
      loadReview(interval);
    },
    onEdit: () => openEdit(interval),
    onDelete: () => setDeleteTarget(interval),
    onCapacity: () => setCapacityTarget(interval),
    onAddIssues: () => setAddIssuesTarget(interval),
    onAssignPI: (parentId: string | null) => assignToPI(interval.id, parentId),
  });

  // Sprint-review / completion dialog: which interval is being completed, and where
  // its incomplete items should go (BACKLOG sentinel, else a planned interval id).
  // Completing runs in two steps: a "review" step surfaces retrospective metrics
  // (efficiency, burn rate, pacing), then a "finalize" step locks it and rehomes
  // any unfinished work (COSMOS-139).
  const [completeTarget, setCompleteTarget] = useState<Interval | null>(null);
  const [moveToIntervalId, setMoveToIntervalId] = useState<string>(BACKLOG_OPTION);
  const [completeStep, setCompleteStep] = useState<"review" | "finalize">("review");
  const [review, setReview] = useState<SprintReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  // Roll-over (COSMOS-19 Phase 4): after a SPRINT completes, offer to start the
  // next one, pre-filled with the same duration + incremented name, inheriting
  // the completed sprint's Program Increment.
  const [nextSprintOpen, setNextSprintOpen] = useState(false);
  const [nextSprintParentId, setNextSprintParentId] = useState<string | null>(null);
  const [nextName, setNextName] = useState("");
  const [nextStart, setNextStart] = useState("");
  const [nextEnd, setNextEnd] = useState("");
  const [startingNext, setStartingNext] = useState(false);

  // Load the interval's items and derive its retrospective metrics for the review
  // step. Metrics are computed on read (never persisted before finalization).
  async function loadReview(interval: Interval) {
    setReviewLoading(true);
    setReview(null);
    try {
      const res = await fetch(`${basePath}/intervals/${interval.id}`);
      if (!res.ok) throw new Error("Failed to load sprint review");
      const detail = await res.json();
      setReview(
        computeSprintReview({
          startDate: interval.startDate,
          endDate: interval.endDate,
          items: (detail.workItems ?? []).map(
            (i: { storyPoints: number | null; columnKey: string }) => ({
              storyPoints: i.storyPoints,
              columnKey: i.columnKey,
            }),
          ),
        }),
      );
    } catch (err) {
      notifyError(err, "Couldn't load the sprint review.");
    } finally {
      setReviewLoading(false);
    }
  }

  const fetchIntervals = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`${basePath}/intervals`);
      if (!res.ok) throw new Error("Failed to load intervals");
      setIntervals(await res.json());
    } catch (err) {
      notifyError(err, "Couldn't load intervals.");
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  // Initial + post-mutation load. Streaming state from inside the effect is the
  // intended pattern here (same as command-palette / okr-board).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    fetchIntervals();
  }, [fetchIntervals]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function resetForm() {
    setEditId(null);
    setName("");
    setGoal("");
    setKind(defaultKind);
    setStartDate("");
    setEndDate("");
  }

  // Open the dialog pre-filled to EDIT an existing interval (FR: "edit/delete a
  // sprint after the fact"). Dates come back as ISO; the date input wants
  // YYYY-MM-DD.
  function openEdit(interval: Interval) {
    setEditId(interval.id);
    setName(interval.name);
    setGoal(interval.goal ?? "");
    setStartDate(interval.startDate ? interval.startDate.slice(0, 10) : "");
    setEndDate(interval.endDate ? interval.endDate.slice(0, 10) : "");
    setOpen(true);
  }

  async function submitInterval() {
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
      // POSTs the full new interval.
      const res = editId
        ? await fetch(`${basePath}/intervals/${editId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: name.trim(),
              goal: goal.trim() || null,
              startDate: new Date(startDate).toISOString(),
              endDate: new Date(endDate).toISOString(),
            }),
          })
        : await fetch(`${basePath}/intervals`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: name.trim(),
              goal: goal.trim() || null,
              startDate: new Date(startDate).toISOString(),
              endDate: new Date(endDate).toISOString(),
              intervalKind: kind,
            }),
          });
      if (!res.ok) throw new Error("Failed to save interval");
      setOpen(false);
      resetForm();
      await fetchIntervals();
    } catch (err) {
      notifyError(err, editId ? "Couldn't update the interval." : "Couldn't create the interval.");
    } finally {
      setSubmitting(false);
    }
  }

  async function activateInterval(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`${basePath}/intervals/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ACTIVE" }),
      });
      if (res.status === 409)
        throw new Error("Another interval is already active — complete it first.");
      if (!res.ok) throw new Error("Failed to start interval");
      await fetchIntervals();
    } catch (err) {
      notifyError(
        err,
        err instanceof Error ? err.message : "Couldn't start the interval.",
      );
    } finally {
      setBusyId(null);
    }
  }

  // Nest a sprint under a Program Increment (parentId = PI id), or detach it
  // (parentId = null) back to the top level.
  async function assignToPI(id: string, parentId: string | null) {
    setBusyId(id);
    try {
      const res = await fetch(`${basePath}/intervals/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId }),
      });
      if (!res.ok) throw new Error("Failed to update the Program Increment");
      await fetchIntervals();
    } catch (err) {
      notifyError(err, "Couldn't move the sprint to that Program Increment.");
    } finally {
      setBusyId(null);
    }
  }

  // Create the next sprint from the (editable) roll-over defaults and activate
  // it immediately — the "auto-start". Inherits the completed sprint's PI.
  async function startNextSprint() {
    if (!nextName.trim() || !nextStart || !nextEnd) return;
    setStartingNext(true);
    try {
      const createRes = await fetch(`${basePath}/intervals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nextName.trim(),
          startDate: new Date(nextStart).toISOString(),
          endDate: new Date(nextEnd).toISOString(),
          intervalKind: "SPRINT",
          parentId: nextSprintParentId,
        }),
      });
      if (!createRes.ok) throw new Error("Failed to create the next sprint");
      const createdInterval = await createRes.json();
      const actRes = await fetch(`${basePath}/intervals/${createdInterval.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ACTIVE" }),
      });
      if (!actRes.ok)
        throw new Error(
          "Created the sprint, but couldn't start it — activate it manually.",
        );
      setNextSprintOpen(false);
      await fetchIntervals();
    } catch (err) {
      notifyError(err, "Couldn't start the next sprint.");
    } finally {
      setStartingNext(false);
    }
  }

  // moveIncompleteToIntervalId: null → incomplete items return to the backlog;
  // an interval id → they roll over into that (planned) interval.
  async function completeInterval(id: string, moveIncompleteToIntervalId: string | null) {
    setBusyId(id);
    const finished = completeTarget; // capture before we clear it below
    try {
      const res = await fetch(`${basePath}/intervals/${id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moveIncompleteToIntervalId }),
      });
      if (!res.ok) throw new Error("Failed to complete interval");
      setCompleteTarget(null);
      setReview(null);
      await fetchIntervals();
      // Only SPRINTs roll over — phases / PIs / releases don't prompt a "next".
      if (finished && finished.intervalKind === "SPRINT") {
        const d = computeNextSprintDefaults(finished);
        setNextName(d.name);
        setNextStart(d.startDate);
        setNextEnd(d.endDate);
        setNextSprintParentId(finished.parentId);
        setNextSprintOpen(true);
      }
    } catch (err) {
      notifyError(err, "Couldn't complete the interval.");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setBusyId(id);
    try {
      const res = await fetch(`${basePath}/intervals/${id}`, { method: "DELETE" });
      if (res.status === 409)
        throw new Error("Active intervals can't be deleted — complete it first.");
      if (!res.ok) throw new Error("Failed to delete interval");
      setDeleteTarget(null);
      await fetchIntervals();
    } catch (err) {
      notifyError(
        err,
        err instanceof Error ? err.message : "Couldn't delete the interval.",
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
          <p className="text-sm text-muted-foreground">Couldn&apos;t load intervals.</p>
          <Button variant="outline" size="sm" onClick={fetchIntervals}>
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
          <h2 className="text-lg font-semibold">Intervals</h2>
          <p className="text-sm text-muted-foreground">
            Plan and track sprints, phases, and iterations.
          </p>
        </div>
        {canCreate && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New interval
          </Button>
        )}
      </div>

      {intervals.length === 0 ? (
        <EmptyState
          illustration={<IterationCcw className="size-10" />}
          title="No intervals yet"
          description={
            canCreate
              ? "Create your first interval to start planning work into time-boxed iterations."
              : "No intervals have been created for this project yet."
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
                  const children = intervals.filter((c) => c.parentId === pi.id);
                  return (
                    <div
                      key={pi.id}
                      className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
                    >
                      <IntervalCard {...cardProps(pi)} />
                      <div className="ml-3 space-y-2 border-l-2 border-primary/20 pl-3">
                        {children.length === 0 ? (
                          <p className="py-1 text-xs text-muted-foreground">
                            No sprints in this PI yet — use “Move to PI” on a sprint below.
                          </p>
                        ) : (
                          children.map((child) => <IntervalCard key={child.id} {...cardProps(child)} />)
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
            // top-level intervals (not PIs, not already grouped under a PI).
            const group = intervals.filter(
              (c) => c.status === status && c.intervalKind !== PI_KIND && c.parentId == null,
            );
            if (group.length === 0) return null;
            return (
              <section key={status} className="space-y-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {label} ({group.length})
                </h3>
                <div className="space-y-3">
                  {group.map((interval) => (
                    <IntervalCard key={interval.id} {...cardProps(interval)} />
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
            <DialogTitle>{editId ? "Edit interval" : "Plan an interval"}</DialogTitle>
            <DialogDescription>
              A time-boxed iteration (sprint, phase, release…) to group and track
              work.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="interval-name">Name</Label>
              <Input
                id="interval-name"
                placeholder="e.g. Sprint 12"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {!editId && (
              <div className="space-y-1.5">
                <Label htmlFor="interval-kind">Kind</Label>
                <Select value={kind} onValueChange={(v) => setKind(v ?? "SPRINT")}>
                  <SelectTrigger id="interval-kind">
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
                <Label htmlFor="interval-start">Start date</Label>
                <Input
                  id="interval-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="interval-end">End date</Label>
                <Input
                  id="interval-end"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="interval-goal">Goal (optional)</Label>
              <Input
                id="interval-goal"
                placeholder="What should this interval achieve?"
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
              onClick={submitInterval}
              disabled={submitting || !name.trim() || !startDate || !endDate}
            >
              {submitting
                ? editId
                  ? "Saving…"
                  : "Creating…"
                : editId
                  ? "Save changes"
                  : "Create interval"}
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
            <DialogTitle>Delete this interval?</DialogTitle>
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
          intervalId={capacityTarget.id}
          intervalName={capacityTarget.name}
          canEdit={canUpdate}
          onClose={() => setCapacityTarget(null)}
        />
      )}

      {/* Start Sprint planning flow — capacity, goal, committed-vs-capacity. */}
      {startTarget && (
        <StartSprintDialog
          orgId={orgId}
          projectId={projectId}
          interval={{
            id: startTarget.id,
            name: startTarget.name,
            goal: startTarget.goal,
          }}
          onClose={() => setStartTarget(null)}
          onStarted={() => {
            setStartTarget(null);
            fetchIntervals();
          }}
        />
      )}

      {/* Add issues to an interval (FR 0e31d1ef) — bulk-move project issues in. */}
      <AddIssuesDialog
        orgId={orgId}
        projectId={projectId}
        projectKey={projectKey}
        interval={addIssuesTarget}
        open={addIssuesTarget !== null}
        onOpenChange={(o) => !o && setAddIssuesTarget(null)}
        onAdded={fetchIntervals}
        intervalNames={intervalNames}
      />

      {/* Sprint review / completion — step 1 shows retrospective metrics, step 2
          finalizes and rehomes unfinished items. */}
      <Dialog
        open={completeTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setCompleteTarget(null);
            setReview(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {completeStep === "review" ? "Sprint review" : "Complete"}{" "}
              {completeTarget ? completeTarget.name : "interval"}
            </DialogTitle>
            <DialogDescription>
              {completeStep === "review"
                ? "How this sprint went. Review the retrospective metrics, then finalize."
                : "Completing locks the interval and records its velocity. Any unfinished work items need a new home — choose where they go."}
            </DialogDescription>
          </DialogHeader>
          {completeStep === "review" ? (
            <div className="space-y-4">
              {reviewLoading || !review ? (
                <div className="grid grid-cols-3 gap-3">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <ReviewStat
                      label="Efficiency"
                      value={`${review.efficiency}%`}
                      hint={
                        review.basis === "points"
                          ? `${review.completedPoints}/${review.totalPoints} pts`
                          : `${review.completedItems}/${review.totalItems} items`
                      }
                    />
                    <ReviewStat
                      label="Burn rate"
                      value={`${review.burnRate}`}
                      hint={`${review.basis === "points" ? "pts" : "items"}/day`}
                    />
                    <ReviewStat
                      label="Pacing"
                      value={review.totalItems === 0 ? "—" : review.pacingStatus}
                      hint={
                        review.totalItems === 0
                          ? "no items yet"
                          : `${review.pacing}× ideal`
                      }
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Completed{" "}
                    <span className="font-medium text-foreground">
                      {review.completedItems}
                    </span>{" "}
                    of {review.totalItems} item{review.totalItems === 1 ? "" : "s"}
                    {review.totalPoints > 0 && (
                      <>
                        {" · "}
                        <span className="font-medium text-foreground">
                          {review.completedPoints}
                        </span>{" "}
                        of {review.totalPoints} pts
                      </>
                    )}{" "}
                    · {review.elapsedDays}/{review.plannedDays} days
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {completeTarget?._count?.workItems != null && (
                <p className="text-sm text-muted-foreground">
                  This interval has{" "}
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
                  value={moveToIntervalId}
                  onValueChange={(v) => setMoveToIntervalId(v ?? BACKLOG_OPTION)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Backlog" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={BACKLOG_OPTION}>Backlog (no interval)</SelectItem>
                    {intervals
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
          )}
          <DialogFooter>
            {completeStep === "review" ? (
              <>
                <Button variant="outline" onClick={() => setCompleteTarget(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => setCompleteStep("finalize")}
                  disabled={reviewLoading}
                >
                  Continue
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => setCompleteStep("review")}
                  disabled={busyId === completeTarget?.id}
                >
                  Back
                </Button>
                <Button
                  onClick={() =>
                    completeTarget &&
                    completeInterval(
                      completeTarget.id,
                      moveToIntervalId === BACKLOG_OPTION ? null : moveToIntervalId,
                    )
                  }
                  disabled={busyId === completeTarget?.id}
                >
                  {busyId === completeTarget?.id ? "Completing…" : "Complete interval"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Roll-over: start the next sprint, pre-filled from the one just completed. */}
      <Dialog
        open={nextSprintOpen}
        onOpenChange={(o) => {
          if (!o && !startingNext) setNextSprintOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start the next sprint?</DialogTitle>
            <DialogDescription>
              Roll straight into the next sprint. We&apos;ve pre-filled the same
              duration and the next name — edit anything, or skip for now.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="next-name">Name</Label>
              <Input
                id="next-name"
                value={nextName}
                onChange={(e) => setNextName(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="next-start">Start</Label>
                <Input
                  id="next-start"
                  type="date"
                  value={nextStart}
                  onChange={(e) => setNextStart(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="next-end">End</Label>
                <Input
                  id="next-end"
                  type="date"
                  value={nextEnd}
                  onChange={(e) => setNextEnd(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNextSprintOpen(false)}
              disabled={startingNext}
            >
              Not now
            </Button>
            <Button onClick={startNextSprint} disabled={startingNext}>
              {startingNext ? "Starting…" : "Start sprint"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// A single retrospective metric tile in the sprint-review step.
function ReviewStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 text-center">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold capitalize">{value}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

interface IntervalCardProps {
  interval: Interval;
  busy: boolean;
  canUpdate: boolean;
  canComplete: boolean;
  /** Available Program Increments, for the "Move to PI" selector. */
  pis: Interval[];
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

function IntervalCard({
  interval,
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
}: IntervalCardProps) {
  const itemCount = interval._count?.workItems ?? 0;
  const report = interval.report;
  const isPI = interval.intervalKind === PI_KIND;
  // A sprint (non-PI, non-completed) can be nested under a PI, if any exist.
  const showPISelect =
    !isPI && canUpdate && interval.status !== "COMPLETED" && pis.length > 0;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-sm truncate">
              {interval.name}
            </h4>
            <Badge variant="neutral" className="shrink-0 text-[10px]">
              {KIND_LABELS[interval.intervalKind] ?? interval.intervalKind} #{interval.number}
            </Badge>
            {interval.status === "ACTIVE" && (
              <Badge variant="progress" className="shrink-0 text-[10px]">
                Active
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {fmtDate(interval.startDate)} – {fmtDate(interval.endDate)} · {itemCount}{" "}
            {itemCount === 1 ? "item" : "items"}
          </p>
          {showPISelect && (
            <div className="mt-2 flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">PI:</span>
              <Select
                value={interval.parentId ?? NO_PI}
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
          {interval.goal && (
            <p className="text-xs text-muted-foreground mt-2 flex items-start gap-1">
              <Target className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>{interval.goal}</span>
            </p>
          )}
          {interval.status === "COMPLETED" && report && (
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
          {interval.status === "PLANNED" && canUpdate && (
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
          {interval.status === "ACTIVE" && canComplete && (
            <Button size="sm" disabled={busy} onClick={onComplete}>
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              Complete
            </Button>
          )}
          {interval.status !== "COMPLETED" && canUpdate && (
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
          {interval.status !== "COMPLETED" && (
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
          {interval.status !== "COMPLETED" && canUpdate && (
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              aria-label="Edit interval"
              title="Edit"
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {interval.status !== "ACTIVE" && canUpdate && (
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              aria-label="Delete interval"
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
