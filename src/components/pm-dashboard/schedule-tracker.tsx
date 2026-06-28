"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
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
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Plus, Trash2, Calendar, AlertTriangle } from "lucide-react";

type MilestoneStatus = "UPCOMING" | "IN_PROGRESS" | "COMPLETED" | "MISSED";

interface BranchLite {
  id: string;
  code: string;
  name: string;
}

interface Milestone {
  id: string;
  title: string;
  description: string | null;
  phase: string | null;
  branchId: string | null;
  programBranch: BranchLite | null;
  baselineDate: string | null;
  dueDate: string; // required, labelled "Projected / current date"
  actualDate: string | null;
  status: MilestoneStatus;
  rootCause: string | null;
  recoveryPlan: string | null;
  recoveryTarget: string | null;
  scheduleEscalate: boolean;
}

export interface ScheduleTrackerProps {
  orgId: string;
  projectId: string;
  branches: BranchLite[];
}

const STATUS_OPTIONS: MilestoneStatus[] = ["UPCOMING", "IN_PROGRESS", "COMPLETED", "MISSED"];

const STATUS_LABEL: Record<MilestoneStatus, string> = {
  UPCOMING: "Upcoming",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  MISSED: "Missed",
};

interface MilestoneForm {
  title: string;
  description: string;
  phase: string;
  branchId: string;
  baselineDate: string;
  dueDate: string;
  actualDate: string;
  status: MilestoneStatus;
  rootCause: string;
  recoveryPlan: string;
  recoveryTarget: string;
  scheduleEscalate: boolean;
}

const emptyForm: MilestoneForm = {
  title: "",
  description: "",
  phase: "",
  branchId: "",
  baselineDate: "",
  dueDate: "",
  actualDate: "",
  status: "UPCOMING",
  rootCause: "",
  recoveryPlan: "",
  recoveryTarget: "",
  scheduleEscalate: false,
};

function toDateInput(iso: string | null | undefined): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

function milestoneToForm(m: Milestone): MilestoneForm {
  return {
    title: m.title,
    description: m.description ?? "",
    phase: m.phase ?? "",
    branchId: m.branchId ?? "",
    baselineDate: toDateInput(m.baselineDate),
    dueDate: toDateInput(m.dueDate),
    actualDate: toDateInput(m.actualDate),
    status: m.status,
    rootCause: m.rootCause ?? "",
    recoveryPlan: m.recoveryPlan ?? "",
    recoveryTarget: toDateInput(m.recoveryTarget),
    scheduleEscalate: m.scheduleEscalate,
  };
}

function formToBody(f: MilestoneForm) {
  return {
    title: f.title.trim(),
    description: f.description.trim() || null,
    phase: f.phase.trim() || null,
    branchId: f.branchId || null,
    baselineDate: f.baselineDate ? new Date(f.baselineDate).toISOString() : null,
    dueDate: new Date(f.dueDate).toISOString(),
    actualDate: f.actualDate ? new Date(f.actualDate).toISOString() : null,
    status: f.status,
    rootCause: f.rootCause.trim() || null,
    recoveryPlan: f.recoveryPlan.trim() || null,
    recoveryTarget: f.recoveryTarget ? new Date(f.recoveryTarget).toISOString() : null,
    scheduleEscalate: f.scheduleEscalate,
  };
}

/** Compute variance in days: dueDate - baselineDate. Positive = slipped. */
function computeVariance(baselineDate: string | null, dueDate: string): number | null {
  if (!baselineDate) return null;
  const base = new Date(baselineDate).getTime();
  const due = new Date(dueDate).getTime();
  return Math.round((due - base) / 86_400_000);
}

type SortKey = "dueDate" | "title" | "variance";

export function ScheduleTracker({ orgId, projectId, branches }: ScheduleTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/schedule`;
  const queryKey = useOrgQueryKey("schedule", projectId);

  const { data: milestones = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<Milestone[]>(apiBase),
  });

  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("dueDate");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Milestone | null>(null);
  const [deleting, setDeleting] = useState<Milestone | null>(null);
  const [form, setForm] = useState<MilestoneForm>(emptyForm);

  const createMutation = useOrgMutation<Milestone, Error, MilestoneForm>({
    mutationFn: (f) =>
      jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["schedule", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the milestone."),
  });

  const updateMutation = useOrgMutation<Milestone, Error, { id: string; f: MilestoneForm }>({
    mutationFn: ({ id, f }) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["schedule", projectId]],
    onSuccess: () => setEditing(null),
    onError: (e) => notifyError(e, "Couldn't update the milestone."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["schedule", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the milestone."),
  });

  const view = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const rows = f
      ? milestones.filter(
          (m) =>
            m.title.toLowerCase().includes(f) ||
            (m.phase ?? "").toLowerCase().includes(f) ||
            (m.programBranch?.code ?? "").toLowerCase().includes(f),
        )
      : milestones.slice();

    rows.sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "variance") {
        const va = computeVariance(a.baselineDate, a.dueDate) ?? -Infinity;
        const vb = computeVariance(b.baselineDate, b.dueDate) ?? -Infinity;
        return vb - va; // largest slip first
      }
      // default: dueDate asc
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    });
    return rows;
  }, [milestones, filter, sort]);

  function openCreate() {
    setForm({ ...emptyForm, branchId: branches[0]?.id ?? "" });
    setCreateOpen(true);
  }

  function openEdit(m: Milestone) {
    setForm(milestoneToForm(m));
    setEditing(m);
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load schedule" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">Schedule Tracker</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {milestones.length} milestone{milestones.length === 1 ? "" : "s"} ·
            variance = projected − baseline
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" /> New Milestone
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title, phase, branch…"
          className="max-w-xs"
        />
        <Select value={sort} onValueChange={(v) => setSort((v ?? "dueDate") as SortKey)}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dueDate">Sort: Projected date</SelectItem>
            <SelectItem value="title">Sort: Title</SelectItem>
            <SelectItem value="variance">Sort: Variance (largest slip)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {view.length === 0 ? (
        <EmptyState
          icon={Calendar}
          title={filter ? "No matching milestones" : "No milestones yet"}
          description={
            filter
              ? "Try a different filter."
              : "Add the first milestone to start tracking the schedule."
          }
          action={
            !filter ? (
              <Button onClick={openCreate}>
                <Plus className="size-4" /> New Milestone
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Branch</th>
                <th className="px-3 py-2 font-medium">Baseline</th>
                <th className="px-3 py-2 font-medium">Projected</th>
                <th className="px-3 py-2 font-medium">Variance</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Esc.</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {view.map((m) => {
                const variance = computeVariance(m.baselineDate, m.dueDate);
                return (
                  <tr
                    key={m.id}
                    className="cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)]"
                    onClick={() => openEdit(m)}
                  >
                    <td className="max-w-xs truncate px-3 py-2 font-medium text-[var(--text)]">
                      {m.title}
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--text-muted)]">
                      {m.programBranch?.code ?? "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-[var(--text-muted)]">
                      {m.baselineDate
                        ? new Date(m.baselineDate).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-[var(--text)]">
                      {new Date(m.dueDate).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      <VariancePill variance={variance} />
                    </td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">
                      {STATUS_LABEL[m.status]}
                    </td>
                    <td className="px-3 py-2">
                      {m.scheduleEscalate ? (
                        <span className="text-[10px] font-semibold uppercase text-[var(--status-blocked,#dc2626)]">
                          Yes
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete milestone"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(m);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create */}
      <MilestoneDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New Milestone"
        form={form}
        setForm={setForm}
        branches={branches}
        pending={createMutation.isPending}
        onSubmit={() => createMutation.mutate(form)}
        submitLabel="Create"
      />

      {/* Edit */}
      <MilestoneDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing ? `Edit: ${editing.title}` : "Edit Milestone"}
        form={form}
        setForm={setForm}
        branches={branches}
        pending={updateMutation.isPending}
        onSubmit={() => editing && updateMutation.mutate({ id: editing.id, f: form })}
        submitLabel="Save"
      />

      {/* Delete confirm */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" /> Delete milestone
            </DialogTitle>
            <DialogDescription>
              Permanently delete{" "}
              <span className="font-medium">{deleting?.title}</span>. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MilestoneDialog({
  open,
  onOpenChange,
  title,
  form,
  setForm,
  branches,
  pending,
  onSubmit,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  form: MilestoneForm;
  setForm: React.Dispatch<React.SetStateAction<MilestoneForm>>;
  branches: BranchLite[];
  pending: boolean;
  onSubmit: () => void;
  submitLabel: string;
}) {
  const isValid = form.title.trim().length > 0 && form.dueDate.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Baseline vs. projected date drives the schedule variance column.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          {/* Title + Phase */}
          <FormField label="Milestone title" required>
            {(p) => (
              <Input
                {...p}
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Short descriptive title"
                autoFocus
              />
            )}
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Phase">
              {(p) => (
                <Input
                  {...p}
                  value={form.phase}
                  onChange={(e) => setForm((f) => ({ ...f, phase: e.target.value }))}
                  placeholder="e.g. Phase 1"
                />
              )}
            </FormField>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Branch</label>
              <Select
                value={form.branchId}
                onValueChange={(v) => setForm((f) => ({ ...f, branchId: v ?? "" }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.code} {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="Baseline date">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.baselineDate}
                  onChange={(e) => setForm((f) => ({ ...f, baselineDate: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Projected / current date" required>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Actual date">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.actualDate}
                  onChange={(e) => setForm((f) => ({ ...f, actualDate: e.target.value }))}
                />
              )}
            </FormField>
          </div>

          {/* Status */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Status</label>
              <Select
                value={form.status}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, status: (v ?? "UPCOMING") as MilestoneStatus }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <FormField label="Description">
            {(p) => (
              <Textarea
                {...p}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Milestone description"
                rows={2}
              />
            )}
          </FormField>

          {/* Recovery fields */}
          <FormField label="Root cause">
            {(p) => (
              <Textarea
                {...p}
                value={form.rootCause}
                onChange={(e) => setForm((f) => ({ ...f, rootCause: e.target.value }))}
                placeholder="Why is this milestone slipping?"
                rows={2}
              />
            )}
          </FormField>
          <FormField label="Recovery plan">
            {(p) => (
              <Textarea
                {...p}
                value={form.recoveryPlan}
                onChange={(e) => setForm((f) => ({ ...f, recoveryPlan: e.target.value }))}
                placeholder="Steps to get back on track"
                rows={2}
              />
            )}
          </FormField>
          <FormField label="Recovery target date">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={form.recoveryTarget}
                onChange={(e) =>
                  setForm((f) => ({ ...f, recoveryTarget: e.target.value }))
                }
              />
            )}
          </FormField>

          <label className="flex items-center gap-2 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={form.scheduleEscalate}
              onChange={(e) =>
                setForm((f) => ({ ...f, scheduleEscalate: e.target.checked }))
              }
              className="size-4 accent-[var(--primary)]"
            />
            Escalate (surfaces in the Government view)
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={pending || !isValid}>
            {pending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VariancePill({ variance }: { variance: number | null }) {
  if (variance === null) {
    return <span className="text-xs text-[var(--text-muted)]">—</span>;
  }
  if (variance <= 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
        On track
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
      +{variance}d
    </span>
  );
}

function TableSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-8 w-32" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
