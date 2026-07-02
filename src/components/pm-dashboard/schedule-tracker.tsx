"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
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
import { Loader2, Trash2, Calendar, AlertTriangle, X, Link2, Eye, CircleDot } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { PmEntityDrawer, type PmField } from "@/components/pm-dashboard/pm-entity-drawer";
import { PmDataTable } from "@/components/pm-dashboard/pm-data-table";
import { bulkFanOut } from "@/lib/pm/bulk";
import type { ActionMenuGroup } from "@/components/ui/action-menu";

type MilestoneStatus = "UPCOMING" | "IN_PROGRESS" | "COMPLETED" | "MISSED";

interface BranchLite {
  id: string;
  code: string;
  name: string;
}

interface WorkItemLite {
  id: string;
  title: string;
  columnKey: string;
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
  // Derived from linked work items (see lib/pm/schedule). status is already the
  // derived value when autoStatus is on and links resolve.
  autoStatus: boolean;
  milestoneType: string | null;
  downstreamImpact: string | null;
  relatedRef: string | null;
  notes: string | null;
  linkedTotal: number;
  linkedDone: number;
  completionPercent: number | null;
  links: { id: string; workItemId: string }[];
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

const STATUS_RANK: Record<MilestoneStatus, number> = {
  UPCOMING: 0,
  IN_PROGRESS: 1,
  COMPLETED: 2,
  MISSED: 3,
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
  autoStatus: boolean;
  milestoneType: string;
  downstreamImpact: string;
  relatedRef: string;
  notes: string;
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
  autoStatus: true,
  milestoneType: "",
  downstreamImpact: "",
  relatedRef: "",
  notes: "",
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
    autoStatus: m.autoStatus,
    milestoneType: m.milestoneType ?? "",
    downstreamImpact: m.downstreamImpact ?? "",
    relatedRef: m.relatedRef ?? "",
    notes: m.notes ?? "",
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
    autoStatus: f.autoStatus,
    milestoneType: f.milestoneType.trim() || null,
    downstreamImpact: f.downstreamImpact.trim() || null,
    relatedRef: f.relatedRef.trim() || null,
    notes: f.notes.trim() || null,
  };
}

/** Compute variance in days: dueDate - baselineDate. Positive = slipped. */
function computeVariance(baselineDate: string | null, dueDate: string): number | null {
  if (!baselineDate) return null;
  const base = new Date(baselineDate).getTime();
  const due = new Date(dueDate).getTime();
  return Math.round((due - base) / 86_400_000);
}

function dateMs(iso: string | null | undefined): number {
  return iso ? new Date(iso).getTime() : 0;
}

// Sortable columns (headers sort on click via the shared DataTable). Pure — no
// component state, so defined at module scope. VariancePill / ProgressCell are
// hoisted function declarations referenced from the cell closures.
const MILESTONE_COLUMNS: ColumnDef<Milestone>[] = [
  {
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => (
      <span className="block max-w-xs truncate font-medium text-[var(--text)]">{row.original.title}</span>
    ),
  },
  {
    id: "branch",
    header: "Branch",
    accessorFn: (m) => m.programBranch?.code ?? "",
    cell: ({ row }) => (
      <span className="text-xs text-[var(--text-muted)]">{row.original.programBranch?.code ?? "—"}</span>
    ),
  },
  {
    id: "baselineDate",
    header: "Baseline",
    accessorFn: (m) => dateMs(m.baselineDate),
    sortingFn: (a, b) => dateMs(a.original.baselineDate) - dateMs(b.original.baselineDate),
    cell: ({ row }) => (
      <span className="tabular-nums text-[var(--text-muted)]">
        {row.original.baselineDate ? new Date(row.original.baselineDate).toLocaleDateString() : "—"}
      </span>
    ),
  },
  {
    id: "dueDate",
    header: "Projected",
    accessorFn: (m) => dateMs(m.dueDate),
    sortingFn: (a, b) => dateMs(a.original.dueDate) - dateMs(b.original.dueDate),
    cell: ({ row }) => (
      <span className="tabular-nums text-[var(--text)]">{new Date(row.original.dueDate).toLocaleDateString()}</span>
    ),
  },
  {
    id: "variance",
    header: "Variance",
    accessorFn: (m) => computeVariance(m.baselineDate, m.dueDate) ?? -Infinity,
    sortingFn: (a, b) => {
      const va = computeVariance(a.original.baselineDate, a.original.dueDate) ?? -Infinity;
      const vb = computeVariance(b.original.baselineDate, b.original.dueDate) ?? -Infinity;
      return va - vb;
    },
    cell: ({ row }) => (
      <VariancePill variance={computeVariance(row.original.baselineDate, row.original.dueDate)} />
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    sortingFn: (a, b) => STATUS_RANK[a.original.status] - STATUS_RANK[b.original.status],
    cell: ({ row }) => (
      <>
        <span className="text-[var(--text-muted)]">{STATUS_LABEL[row.original.status]}</span>
        {row.original.autoStatus && row.original.linkedTotal > 0 && (
          <span
            className="ml-1.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-[var(--primary)]"
            title="Status derived from linked work items"
          >
            auto
          </span>
        )}
      </>
    ),
  },
  {
    id: "progress",
    header: "Progress",
    accessorFn: (m) => m.completionPercent ?? -1,
    cell: ({ row }) => (
      <ProgressCell
        done={row.original.linkedDone}
        total={row.original.linkedTotal}
        percent={row.original.completionPercent}
      />
    ),
  },
  {
    id: "escalate",
    header: "Esc.",
    accessorFn: (m) => (m.scheduleEscalate ? 1 : 0),
    cell: ({ row }) =>
      row.original.scheduleEscalate ? (
        <span className="text-[10px] font-semibold uppercase text-[var(--status-blocked,#dc2626)]">Yes</span>
      ) : (
        <span className="text-xs text-[var(--text-muted)]">—</span>
      ),
  },
];

export function ScheduleTracker({ orgId, projectId, branches }: ScheduleTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/schedule`;
  const queryKey = useOrgQueryKey("schedule", projectId);
  const canEdit = usePermissions().can(Permission.PROJECT_UPDATE);

  const { data: milestones = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<Milestone[]>(apiBase),
  });

  // Work items power the linking picker + resolve linked-item titles.
  const workItemsKey = useOrgQueryKey("work-items", projectId);
  const { data: workItems = [] } = useQuery({
    queryKey: workItemsKey,
    queryFn: () =>
      jsonFetch<WorkItemLite[]>(`/api/v1/orgs/${orgId}/projects/${projectId}/work-items`),
  });

  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Milestone | null>(null);
  const [deleting, setDeleting] = useState<Milestone | null>(null);
  const [form, setForm] = useState<MilestoneForm>(emptyForm);
  // The drawer is the primary row-detail view. We hold the open milestone's id so
  // the drawer's fields rebuild from the freshest cached row after an inline PATCH.
  // The edit dialog (which hosts work-item linking) stays reachable via the row's
  // edit-icon button — the drawer's PmField model can't host the link panel.
  const [openMilestoneId, setOpenMilestoneId] = useState<string | null>(null);
  const openMilestone = openMilestoneId
    ? milestones.find((m) => m.id === openMilestoneId) ?? null
    : null;

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

  // Link / unlink work items so a milestone's status + completion derive from them.
  const milestonesBase = `/api/v1/orgs/${orgId}/projects/${projectId}/milestones`;
  const linkMutation = useOrgMutation<unknown, Error, { milestoneId: string; workItemId: string }>({
    mutationFn: ({ milestoneId, workItemId }) =>
      jsonFetch(`${milestonesBase}/${milestoneId}/links`, {
        method: "POST",
        body: JSON.stringify({ workItemId }),
      }),
    invalidate: [["schedule", projectId]],
    onError: (e) => notifyError(e, "Couldn't link the work item."),
  });
  const unlinkMutation = useOrgMutation<unknown, Error, { milestoneId: string; linkId: string }>({
    mutationFn: ({ milestoneId, linkId }) =>
      jsonFetch(`${milestonesBase}/${milestoneId}/links/${linkId}`, { method: "DELETE" }),
    invalidate: [["schedule", projectId]],
    onError: (e) => notifyError(e, "Couldn't unlink the work item."),
  });

  const patch = useCallback(
    (id: string, body: Record<string, unknown>) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    [apiBase],
  );

  // Right-click / ⋯ row menu: view+edit (drawer), quick status, edit + linked
  // items (the work-item-link dialog), delete.
  const rowActions = useCallback(
    (m: Milestone): ActionMenuGroup[] => {
      const groups: ActionMenuGroup[] = [
        { items: [{ label: "View / edit", icon: Eye, onClick: () => setOpenMilestoneId(m.id) }] },
      ];
      if (canEdit) {
        groups.push({
          label: "Set status",
          items: STATUS_OPTIONS.map((st) => ({
            label: STATUS_LABEL[st],
            icon: CircleDot,
            onClick: async () => {
              try {
                await patch(m.id, { status: st });
                void refetch();
              } catch (e) {
                notifyError(e, "Couldn't update status.");
              }
            },
          })),
        });
        groups.push({
          items: [
            {
              label: "Edit & linked items",
              icon: Link2,
              onClick: () => {
                setForm(milestoneToForm(m));
                setEditing(m);
              },
            },
          ],
        });
        groups.push({ items: [{ label: "Delete", icon: Trash2, variant: "destructive", onClick: () => setDeleting(m) }] });
      }
      return groups;
    },
    [canEdit, patch, refetch],
  );

  function openCreate() {
    setForm({ ...emptyForm, branchId: branches[0]?.id ?? "" });
    setCreateOpen(true);
  }

  // The freshest copy of the milestone being edited, so its linked-items list
  // updates after a link/unlink without reopening the dialog.
  const editingFresh = editing
    ? milestones.find((m) => m.id === editing.id) ?? editing
    : null;

  // Build the drawer's inline-editable field list for the open milestone. Most
  // fields are editable and PATCH the schedule endpoint by key; progress and the
  // linked done/total counts are derived server-side from linked work items and
  // shown read-only (the "trickle up" signal). Linking itself stays in the edit
  // dialog, which the row's edit-icon button still opens.
  function milestoneFields(m: Milestone): PmField[] {
    return [
      { key: "title", label: "Title", type: "text", value: m.title, editable: canEdit },
      { key: "phase", label: "Phase", type: "text", value: m.phase, editable: canEdit },
      {
        key: "branchId",
        label: "Branch",
        type: "select",
        value: m.branchId,
        editable: canEdit && branches.length > 0,
        options: branches.map((b) => ({ value: b.id, label: `${b.code} ${b.name}` })),
        placeholder: "Select branch",
      },
      {
        key: "baselineDate",
        label: "Baseline date",
        type: "date",
        value: m.baselineDate,
        editable: canEdit,
      },
      {
        key: "dueDate",
        label: "Projected / current date",
        type: "date",
        value: m.dueDate,
        editable: canEdit,
      },
      {
        key: "actualDate",
        label: "Actual date",
        type: "date",
        value: m.actualDate,
        editable: canEdit,
      },
      {
        key: "status",
        label: "Status",
        type: "select",
        value: m.status,
        editable: canEdit,
        options: STATUS_OPTIONS.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
      },
      {
        key: "autoStatus",
        label: "Auto-derive status from linked items",
        type: "select",
        value: m.autoStatus ? "true" : "false",
        editable: canEdit,
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
        coerce: (v) => v === "true",
      },
      {
        key: "scheduleEscalate",
        label: "Escalate",
        type: "select",
        value: m.scheduleEscalate ? "true" : "false",
        editable: canEdit,
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
        coerce: (v) => v === "true",
      },
      {
        key: "milestoneType",
        label: "Milestone type",
        type: "text",
        value: m.milestoneType,
        editable: canEdit,
      },
      {
        key: "relatedRef",
        label: "Related reference",
        type: "text",
        value: m.relatedRef,
        editable: canEdit,
      },
      // Derived (read-only) — the trickle-up signal from linked work items.
      {
        key: "completionPercent",
        label: "Progress %",
        type: "number",
        value: m.completionPercent,
        editable: false,
      },
      {
        key: "linkedProgress",
        label: "Linked done / total",
        type: "text",
        value: `${m.linkedDone}/${m.linkedTotal}`,
        editable: false,
      },
      {
        key: "description",
        label: "Description",
        type: "textarea",
        value: m.description,
        editable: canEdit,
        placeholder: "Milestone description",
      },
      {
        key: "rootCause",
        label: "Root cause",
        type: "textarea",
        value: m.rootCause,
        editable: canEdit,
        placeholder: "Why is this milestone slipping?",
      },
      {
        key: "recoveryPlan",
        label: "Recovery plan",
        type: "textarea",
        value: m.recoveryPlan,
        editable: canEdit,
        placeholder: "Steps to get back on track",
      },
      {
        key: "recoveryTarget",
        label: "Recovery target date",
        type: "date",
        value: m.recoveryTarget,
        editable: canEdit,
      },
      {
        key: "downstreamImpact",
        label: "Downstream impact",
        type: "textarea",
        value: m.downstreamImpact,
        editable: canEdit,
        placeholder: "Describe downstream effects if this milestone slips",
      },
      {
        key: "notes",
        label: "Notes",
        type: "textarea",
        value: m.notes,
        editable: canEdit,
        placeholder: "Additional notes",
      },
    ];
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load schedule" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <>
      <PmDataTable
        title="Schedule Tracker"
        subtitle={`${milestones.length} milestone${milestones.length === 1 ? "" : "s"} · variance = projected − baseline`}
        rows={milestones}
        columns={MILESTONE_COLUMNS}
        search={filter}
        onSearchChange={setFilter}
        searchText={(m) => [m.title, m.phase ?? "", m.programBranch?.code ?? ""].join(" ")}
        searchPlaceholder="Filter by title, phase, branch…"
        onRowClick={(m) => setOpenMilestoneId(m.id)}
        rowActions={rowActions}
        onNew={canEdit ? openCreate : undefined}
        newLabel="New Milestone"
        renderBulkActions={
          canEdit
            ? (ids, clear) => (
                <>
                  <Select
                    onValueChange={async (v) => {
                      if (!v) return;
                      await bulkFanOut(ids, (id) => patch(id, { status: v }));
                      void refetch();
                      clear();
                    }}
                  >
                    <SelectTrigger className="h-8 w-40">
                      <SelectValue placeholder="Set status…" />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((st) => (
                        <SelectItem key={st} value={st}>{STATUS_LABEL[st]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={async () => {
                      if (!window.confirm(`Delete ${ids.length} milestone${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
                      await bulkFanOut(ids, (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }));
                      void refetch();
                      clear();
                    }}
                  >
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                </>
              )
            : undefined
        }
        emptyIcon={Calendar}
        emptyTitle="No milestones yet"
        emptyDescription="Add the first milestone to start tracking the schedule."
      />

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
        milestone={editingFresh}
        workItems={workItems}
        onLink={(workItemId) =>
          editing && linkMutation.mutate({ milestoneId: editing.id, workItemId })
        }
        onUnlink={(linkId) => editing && unlinkMutation.mutate({ milestoneId: editing.id, linkId })}
        linkBusy={linkMutation.isPending || unlinkMutation.isPending}
      />

      {/* Detail drawer — issue-style: inline-editable fields + Comments + Activity.
          Primary row-detail view (row click). Work-item linking stays in the edit
          dialog, reachable via the row's edit-icon button. */}
      {openMilestone && (
        <PmEntityDrawer
          key={openMilestone.id}
          orgId={orgId}
          projectId={projectId}
          subjectType="milestone"
          subjectId={openMilestone.id}
          title={openMilestone.title}
          code={null}
          patchPath={`${apiBase}/${openMilestone.id}`}
          fields={milestoneFields(openMilestone)}
          open={openMilestoneId !== null}
          onOpenChange={(o) => !o && setOpenMilestoneId(null)}
          onSaved={() => void refetch()}
        />
      )}

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
    </>
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
  milestone,
  workItems,
  onLink,
  onUnlink,
  linkBusy,
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
  milestone?: Milestone | null;
  workItems?: WorkItemLite[];
  onLink?: (workItemId: string) => void;
  onUnlink?: (linkId: string) => void;
  linkBusy?: boolean;
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

          <label className="flex items-start gap-2 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={form.autoStatus}
              onChange={(e) => setForm((f) => ({ ...f, autoStatus: e.target.checked }))}
              className="mt-0.5 size-4 accent-[var(--primary)]"
            />
            <span>
              Derive status from linked work items
              <span className="block text-xs text-[var(--text-muted)]">
                When on, status &amp; progress roll up from the work items linked to this
                milestone; the status above is the manual fallback.
              </span>
            </span>
          </label>

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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Milestone type">
              {(p) => (
                <Input
                  {...p}
                  value={form.milestoneType}
                  onChange={(e) => setForm((f) => ({ ...f, milestoneType: e.target.value }))}
                  placeholder="e.g. CDR, PDR, delivery"
                />
              )}
            </FormField>
            <FormField label="Related reference">
              {(p) => (
                <Input
                  {...p}
                  value={form.relatedRef}
                  onChange={(e) => setForm((f) => ({ ...f, relatedRef: e.target.value }))}
                  placeholder="e.g. CR-001, R-003"
                />
              )}
            </FormField>
          </div>
          <FormField label="Downstream impact">
            {(p) => (
              <Textarea
                {...p}
                value={form.downstreamImpact}
                onChange={(e) => setForm((f) => ({ ...f, downstreamImpact: e.target.value }))}
                placeholder="Describe downstream effects if this milestone slips"
                rows={2}
              />
            )}
          </FormField>
          <FormField label="Notes">
            {(p) => (
              <Textarea
                {...p}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Additional notes"
                rows={2}
              />
            )}
          </FormField>

          {milestone && onLink && onUnlink && (
            <LinkedWorkItems
              milestone={milestone}
              workItems={workItems ?? []}
              onLink={onLink}
              onUnlink={onUnlink}
              busy={!!linkBusy}
            />
          )}
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

/** Link / unlink the work items a milestone's status + completion derive from. */
function LinkedWorkItems({
  milestone,
  workItems,
  onLink,
  onUnlink,
  busy,
}: {
  milestone: Milestone;
  workItems: WorkItemLite[];
  onLink: (workItemId: string) => void;
  onUnlink: (linkId: string) => void;
  busy: boolean;
}) {
  const byId = new Map(workItems.map((w) => [w.id, w]));
  const linkedIds = new Set(milestone.links.map((l) => l.workItemId));
  const available = workItems.filter((w) => !linkedIds.has(w.id));

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-[var(--text)]">Linked work items</span>
        <span className="text-xs text-[var(--text-muted)]">
          {milestone.linkedDone}/{milestone.linkedTotal} done · status &amp; progress derive from
          these
        </span>
      </div>

      {milestone.links.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          None yet — link work items so this milestone rolls up from execution.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {milestone.links.map((l) => {
            const wi = byId.get(l.workItemId);
            return (
              <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-[var(--text)]">
                  {wi?.title ?? "(unknown work item)"}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {wi && (
                    <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                      {wi.columnKey}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Unlink work item"
                    disabled={busy}
                    onClick={() => onUnlink(l.id)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {available.length > 0 && (
        <Select value="" onValueChange={(v) => v && onLink(v)}>
          <SelectTrigger className="w-full" disabled={busy}>
            <SelectValue placeholder="Link a work item…" />
          </SelectTrigger>
          <SelectContent>
            {available.slice(0, 100).map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

/** Completion of a milestone's linked work items — the "trickle up" signal. */
function ProgressCell({
  done,
  total,
  percent,
}: {
  done: number;
  total: number;
  percent: number | null;
}) {
  if (percent === null || total === 0) {
    return <span className="text-xs text-[var(--text-muted)]">—</span>;
  }
  return (
    <div
      className="flex items-center gap-2"
      title={`${done} of ${total} linked work items done`}
    >
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className="h-full rounded-full bg-[var(--primary)]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="tabular-nums text-xs text-[var(--text-muted)]">
        {done}/{total}
      </span>
    </div>
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
