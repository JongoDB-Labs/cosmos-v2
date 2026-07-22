"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { healthOf, slipDays } from "@/lib/schedule/health";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
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
import { Loader2, Trash2, FileText, AlertTriangle, Eye, Flag, CircleDot } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { PmEntityDrawer, type PmField } from "@/components/pm-dashboard/pm-entity-drawer";
import { PmDataTable } from "@/components/pm-dashboard/pm-data-table";
import { bulkFanOut } from "@/lib/pm/bulk";
import type { ActionMenuGroup } from "@/components/ui/action-menu";

type DeliverableStatus =
  | "NOT_STARTED"
  | "DRAFT_IN_PROGRESS"
  | "INTERNAL_REVIEW"
  | "SUBMITTED"
  | "IN_GOVT_REVIEW"
  | "ACCEPTED"
  | "ACCEPTED_WITH_COMMENTS"
  | "REVISION_REQUIRED"
  | "REJECTED"
  | "OVERDUE";

interface BranchLite {
  id: string;
  code: string;
  name: string;
}

interface Deliverable {
  id: string;
  code: string;
  title: string;
  description: string | null;
  deliverableType: string | null;
  clin: string | null;
  branchId: string | null;
  programBranch: BranchLite | null;
  owner: string | null;
  baselineDue: string | null;
  internalReview: string | null;
  actualSubmission: string | null;
  govReviewPeriod: number | null;
  govAcceptance: string | null;
  revisionCycle: number;
  revRequired: boolean;
  escalate: boolean;
  status: DeliverableStatus;
  branchOwner: string | null;
  workItemRef: string | null;
  notes: string | null;
}

interface DeliverableTrackerProps {
  orgId: string;
  projectId: string;
  branches: BranchLite[];
}

const STATUS_OPTIONS: DeliverableStatus[] = [
  "NOT_STARTED",
  "DRAFT_IN_PROGRESS",
  "INTERNAL_REVIEW",
  "SUBMITTED",
  "IN_GOVT_REVIEW",
  "ACCEPTED",
  "ACCEPTED_WITH_COMMENTS",
  "REVISION_REQUIRED",
  "REJECTED",
  "OVERDUE",
];

const TYPE_OPTIONS = ["SSP", "POA&M", "Report", "Design Doc", "Plan", "Brief", "Other"];

const STATUS_LABEL: Record<DeliverableStatus, string> = {
  NOT_STARTED: "Not Started",
  DRAFT_IN_PROGRESS: "Draft In Progress",
  INTERNAL_REVIEW: "Internal Review",
  SUBMITTED: "Submitted",
  IN_GOVT_REVIEW: "In Govt Review",
  ACCEPTED: "Accepted",
  ACCEPTED_WITH_COMMENTS: "Accepted With Comments",
  REVISION_REQUIRED: "Revision Required",
  REJECTED: "Rejected",
  OVERDUE: "Overdue",
};

interface DeliverableForm {
  title: string;
  description: string;
  deliverableType: string;
  clin: string;
  branchId: string;
  owner: string;
  baselineDue: string;
  internalReview: string;
  actualSubmission: string;
  govReviewPeriod: string;
  govAcceptance: string;
  revisionCycle: string;
  revRequired: boolean;
  escalate: boolean;
  status: DeliverableStatus;
  branchOwner: string;
  workItemRef: string;
  notes: string;
}

const emptyForm: DeliverableForm = {
  title: "",
  description: "",
  deliverableType: "Report",
  clin: "",
  branchId: "",
  owner: "",
  baselineDue: "",
  internalReview: "",
  actualSubmission: "",
  govReviewPeriod: "",
  govAcceptance: "",
  revisionCycle: "",
  revRequired: false,
  escalate: false,
  status: "NOT_STARTED",
  branchOwner: "",
  workItemRef: "",
  notes: "",
};

function formToBody(f: DeliverableForm) {
  return {
    title: f.title.trim(),
    description: f.description.trim() || null,
    deliverableType: f.deliverableType || null,
    clin: f.clin.trim() || null,
    branchId: f.branchId || null,
    owner: f.owner.trim() || null,
    baselineDue: f.baselineDue ? new Date(f.baselineDue).toISOString() : null,
    internalReview: f.internalReview ? new Date(f.internalReview).toISOString() : null,
    actualSubmission: f.actualSubmission ? new Date(f.actualSubmission).toISOString() : null,
    govReviewPeriod: f.govReviewPeriod !== "" ? Number(f.govReviewPeriod) : null,
    govAcceptance: f.govAcceptance ? new Date(f.govAcceptance).toISOString() : null,
    revisionCycle: f.revisionCycle !== "" ? Number(f.revisionCycle) : null,
    revRequired: f.revRequired,
    escalate: f.escalate,
    status: f.status,
    branchOwner: f.branchOwner.trim() || null,
    workItemRef: f.workItemRef.trim() || null,
    notes: f.notes.trim() || null,
  };
}

function computeEarlyLate(baselineDue: string | null, actualSubmission: string | null): string {
  if (!actualSubmission) return "—";
  if (!baselineDue) return "—";
  const baseline = new Date(baselineDue).getTime();
  const submission = new Date(actualSubmission).getTime();
  const days = Math.round((submission - baseline) / 86400000);
  if (days < 0) return `${-days}d early`;
  if (days === 0) return "On time";
  return `${days}d late`;
}

// Status sorts by workflow order (STATUS_OPTIONS), not alphabetically.
const STATUS_RANK: Record<DeliverableStatus, number> = Object.fromEntries(
  STATUS_OPTIONS.map((s, i) => [s, i]),
) as Record<DeliverableStatus, number>;

// Due (Projected) timestamp — missing dates sort last.
function baselineTime(d: Deliverable): number {
  return d.baselineDue ? new Date(d.baselineDue).getTime() : Infinity;
}

// Signed day delta from the shared schedule-health rule (negative = early,
// positive = late; falls back to today vs. due date while still open). null
// when there's no due date — sorts last.
function earlyLateDays(baselineDue: string | null, actualSubmission: string | null): number | null {
  return slipDays({
    projectedEnd: baselineDue ? new Date(baselineDue) : null,
    actualEnd: actualSubmission ? new Date(actualSubmission) : null,
    now: new Date(),
  });
}

// Sortable columns (headers sort on click via the shared DataTable). Pure — no
// component state, so defined at module scope. Status sorts by workflow rank;
// Due (Projected) + Early/Late sort numerically (not by their rendered strings).
const DELIVERABLE_COLUMNS: ColumnDef<Deliverable>[] = [
  {
    accessorKey: "code",
    header: "ID",
    cell: ({ row }) => <span className="font-mono text-xs text-[var(--text-muted)]">{row.original.code}</span>,
  },
  {
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => <span className="block max-w-xs truncate text-[var(--text)]">{row.original.title}</span>,
  },
  {
    id: "clin",
    header: "CLIN",
    accessorFn: (d) => d.clin ?? "",
    cell: ({ row }) => <span className="text-xs text-[var(--text-muted)]">{row.original.clin ?? "—"}</span>,
  },
  {
    id: "branch",
    header: "Branch",
    accessorFn: (d) => d.programBranch?.code ?? "",
    cell: ({ row }) => <span className="text-xs text-[var(--text-muted)]">{row.original.programBranch?.code ?? "—"}</span>,
  },
  {
    accessorKey: "status",
    header: "Status",
    sortingFn: (a, b) => STATUS_RANK[a.original.status] - STATUS_RANK[b.original.status],
    cell: ({ row }) => <span className="text-[var(--text-muted)]">{STATUS_LABEL[row.original.status]}</span>,
  },
  {
    id: "baselineDue",
    header: "Due (Projected)",
    accessorFn: (d) => baselineTime(d),
    sortingFn: (a, b) => baselineTime(a.original) - baselineTime(b.original),
    cell: ({ row }) => (
      <span className="text-[var(--text-muted)]">
        {row.original.baselineDue ? new Date(row.original.baselineDue).toLocaleDateString() : "—"}
      </span>
    ),
  },
  {
    id: "earlyLate",
    header: "Early/Late",
    accessorFn: (d) => earlyLateDays(d.baselineDue, d.actualSubmission) ?? Infinity,
    sortingFn: (a, b) => {
      const av = earlyLateDays(a.original.baselineDue, a.original.actualSubmission) ?? Infinity;
      const bv = earlyLateDays(b.original.baselineDue, b.original.actualSubmission) ?? Infinity;
      return av - bv;
    },
    cell: ({ row }) => {
      const health = healthOf({
        projectedEnd: row.original.baselineDue ? new Date(row.original.baselineDue) : null,
        actualEnd: row.original.actualSubmission ? new Date(row.original.actualSubmission) : null,
        now: new Date(),
      });
      const isLate = health === "red";
      const isEarly = health === "green" && row.original.actualSubmission != null;
      // Open + past due (no actualSubmission yet, but already red) — show the
      // live overdue count instead of computeEarlyLate's "—", which otherwise
      // renders blank-but-red and disagrees with the sort.
      const earlyLate =
        !row.original.actualSubmission && isLate
          ? `${earlyLateDays(row.original.baselineDue, row.original.actualSubmission)}d overdue`
          : computeEarlyLate(row.original.baselineDue, row.original.actualSubmission);
      return (
        <span
          className={
            isLate
              ? "text-xs font-medium text-[var(--status-blocked,#dc2626)]"
              : isEarly
                ? "text-xs font-medium text-[var(--status-ok,#16a34a)]"
                : "text-xs text-[var(--text-muted)]"
          }
        >
          {earlyLate}
        </span>
      );
    },
  },
];

export function DeliverableTracker({ orgId, projectId, branches }: DeliverableTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/deliverables`;
  const queryKey = useOrgQueryKey("deliverables", projectId);
  const { data: deliverables = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<Deliverable[]>(apiBase),
  });
  const canEdit = usePermissions().can(Permission.PROJECT_UPDATE);

  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<Deliverable | null>(null);
  const [form, setForm] = useState<DeliverableForm>(emptyForm);
  // The drawer is the primary row-detail view. We hold the open deliverable's id
  // so the drawer's fields rebuild from the freshest cached row after an inline PATCH.
  const [openDeliverableId, setOpenDeliverableId] = useState<string | null>(null);
  const openDeliverable = openDeliverableId
    ? deliverables.find((d) => d.id === openDeliverableId) ?? null
    : null;

  // Deep-link: `?open=<id>` (e.g. a click from the Release Timeline) opens that
  // deliverable's detail drawer once its row has loaded — so a reference from any
  // view lands on the SAME editable surface (COSMOS-45). Fires once; closing the
  // drawer afterwards leaves it closed even though the param persists in the URL.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || typeof window === "undefined") return;
    const id = new URLSearchParams(window.location.search).get("open");
    if (!id) {
      deepLinkHandled.current = true;
      return;
    }
    if (deliverables.some((d) => d.id === id)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenDeliverableId(id);
      deepLinkHandled.current = true;
    }
  }, [deliverables]);

  const createMutation = useOrgMutation<Deliverable, Error, DeliverableForm>({
    mutationFn: (f) => jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["deliverables", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the deliverable."),
  });
  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["deliverables", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the deliverable."),
  });

  const patch = useCallback(
    (id: string, body: Record<string, unknown>) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    [apiBase],
  );

  // Right-click / ⋯ row menu: view+edit, quick status, escalate toggle, delete.
  const rowActions = useCallback(
    (d: Deliverable): ActionMenuGroup[] => {
      const groups: ActionMenuGroup[] = [
        { items: [{ label: "View / edit", icon: Eye, onClick: () => setOpenDeliverableId(d.id) }] },
      ];
      if (canEdit) {
        groups.push({
          label: "Set status",
          items: STATUS_OPTIONS.map((st) => ({
            label: STATUS_LABEL[st],
            icon: CircleDot,
            onClick: async () => {
              try {
                await patch(d.id, { status: st });
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
              label: d.escalate ? "Remove escalation" : "Escalate to customer",
              icon: Flag,
              onClick: async () => {
                try {
                  await patch(d.id, { escalate: !d.escalate });
                  void refetch();
                } catch (e) {
                  notifyError(e, "Couldn't update escalation.");
                }
              },
            },
          ],
        });
        groups.push({ items: [{ label: "Delete", icon: Trash2, variant: "destructive", onClick: () => setDeleting(d) }] });
      }
      return groups;
    },
    [canEdit, patch, refetch],
  );

  // MSR roll-up — the headline numbers a PM reports in government reviews
  // (mirrors the deliverable tracker's "Summary Dashboard" sheet).
  // Stable "now" captured once at mount (Date.now() in render/useMemo is impure).
  const [now] = useState(() => Date.now());
  const metrics = useMemo(() => {
    const in60 = now + 60 * 86_400_000;
    let submitted = 0, onTime = 0, overdue = 0, due60 = 0;
    for (const d of deliverables) {
      const due = d.baselineDue ? new Date(d.baselineDue).getTime() : null;
      const sub = d.actualSubmission ? new Date(d.actualSubmission).getTime() : null;
      if (sub) {
        submitted++;
        if (due == null || sub <= due) onTime++;
      } else if (due != null && due < now) {
        overdue++;
      } else if (due != null && due <= in60) {
        due60++;
      }
    }
    return {
      total: deliverables.length,
      submitted,
      onTimeRate: submitted > 0 ? Math.round((onTime / submitted) * 100) : null,
      overdue,
      due60,
    };
  }, [deliverables, now]);

  function openCreate() {
    setForm({ ...emptyForm, branchId: branches[0]?.id ?? "" });
    setCreateOpen(true);
  }
  // Row click → open the detail drawer (the primary row-detail view).
  function openDetail(d: Deliverable) {
    setOpenDeliverableId(d.id);
  }

  // Build the drawer's inline-editable field list for the open deliverable. Each
  // field PATCHes the deliverable endpoint by key. The early/late indicator is
  // table-only, so there are no derived read-only fields here.
  function deliverableFields(d: Deliverable): PmField[] {
    return [
      { key: "title", label: "Title", type: "text", value: d.title, editable: canEdit },
      {
        key: "description",
        label: "Description",
        type: "textarea",
        value: d.description,
        editable: canEdit,
        placeholder: "Purpose and scope of this deliverable",
      },
      {
        key: "deliverableType",
        label: "Type",
        type: "select",
        value: d.deliverableType,
        editable: canEdit,
        options: TYPE_OPTIONS.map((o) => ({ value: o, label: o })),
        placeholder: "Select type",
      },
      { key: "clin", label: "CLIN", type: "text", value: d.clin, editable: canEdit },
      {
        key: "branchId",
        label: "Branch",
        type: "select",
        value: d.branchId,
        editable: canEdit && branches.length > 0,
        options: branches.map((b) => ({ value: b.id, label: `${b.code} ${b.name}` })),
        placeholder: "Select branch",
      },
      { key: "owner", label: "Owner", type: "text", value: d.owner, editable: canEdit },
      {
        key: "status",
        label: "Status",
        type: "select",
        value: d.status,
        editable: canEdit,
        options: STATUS_OPTIONS.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
      },
      { key: "baselineDue", label: "Due (Projected)", type: "date", value: d.baselineDue, editable: canEdit },
      {
        key: "internalReview",
        label: "Internal review date",
        type: "date",
        value: d.internalReview,
        editable: canEdit,
      },
      {
        key: "actualSubmission",
        label: "Actual submission",
        type: "date",
        value: d.actualSubmission,
        editable: canEdit,
      },
      {
        key: "govReviewPeriod",
        label: "Govt review period (days)",
        type: "number",
        value: d.govReviewPeriod,
        editable: canEdit,
        min: 0,
      },
      {
        key: "govAcceptance",
        label: "Govt acceptance date",
        type: "date",
        value: d.govAcceptance,
        editable: canEdit,
      },
      {
        key: "revisionCycle",
        label: "Revision cycle",
        type: "number",
        value: d.revisionCycle,
        editable: canEdit,
        min: 0,
      },
      {
        key: "revRequired",
        label: "Revision required",
        type: "select",
        value: d.revRequired ? "true" : "false",
        editable: canEdit,
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
        coerce: (v) => v === "true",
      },
      {
        key: "escalate",
        label: "Escalate to customer",
        type: "select",
        value: d.escalate ? "true" : "false",
        editable: canEdit,
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
        coerce: (v) => v === "true",
      },
      { key: "branchOwner", label: "Branch owner", type: "text", value: d.branchOwner, editable: canEdit },
      { key: "workItemRef", label: "Work item reference", type: "text", value: d.workItemRef, editable: canEdit },
      {
        key: "notes",
        label: "Notes",
        type: "textarea",
        value: d.notes,
        editable: canEdit,
        placeholder: "Additional notes",
      },
    ];
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load deliverables" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <>
      {/* MSR roll-up metrics — headline numbers a PM reports in government reviews. */}
      <div className="mx-auto flex max-w-6xl flex-wrap gap-2 px-6 pt-6">
        {[
          { l: "Total", v: String(metrics.total) },
          { l: "Submitted", v: String(metrics.submitted) },
          { l: "On-time rate", v: metrics.onTimeRate == null ? "—" : `${metrics.onTimeRate}%` },
          { l: "Overdue", v: String(metrics.overdue), bad: metrics.overdue > 0 },
          { l: "Due ≤60d", v: String(metrics.due60), warn: metrics.due60 > 0 },
        ].map((m) => (
          <div
            key={m.l}
            className={cn(
              "rounded-md border px-3 py-1.5",
              m.bad && "border-red-500/40",
              m.warn && "border-amber-500/40",
            )}
          >
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{m.l}</div>
            <div className="text-sm font-semibold tabular-nums">{m.v}</div>
          </div>
        ))}
      </div>

      <PmDataTable
        title="Deliverable Register"
        subtitle={`${deliverables.length} deliverable${deliverables.length === 1 ? "" : "s"} · CDRL tracking`}
        rows={deliverables}
        columns={DELIVERABLE_COLUMNS}
        search={filter}
        onSearchChange={setFilter}
        searchText={(d) => [d.code, d.title, d.clin ?? "", d.owner ?? "", d.programBranch?.name ?? ""].join(" ")}
        searchPlaceholder="Filter by title, ID, CLIN, owner, branch…"
        onRowClick={openDetail}
        rowActions={rowActions}
        onNew={canEdit ? openCreate : undefined}
        newLabel="New Deliverable"
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
                      if (!window.confirm(`Delete ${ids.length} deliverable${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
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
        emptyIcon={FileText}
        emptyTitle="No deliverables yet"
        emptyDescription="Log the first deliverable to start tracking CDRLs."
      />

      {/* Create */}
      <DeliverableDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New Deliverable"
        form={form}
        setForm={setForm}
        branches={branches}
        pending={createMutation.isPending}
        onSubmit={() => createMutation.mutate(form)}
        submitLabel="Create"
      />
      {/* Detail drawer — issue-style: inline-editable fields + Comments + Activity.
          Replaces the old edit dialog as the primary row-detail view. */}
      {openDeliverable && (
        <PmEntityDrawer
          key={openDeliverable.id}
          orgId={orgId}
          projectId={projectId}
          subjectType="deliverable"
          subjectId={openDeliverable.id}
          title={openDeliverable.title}
          code={openDeliverable.code}
          patchPath={`${apiBase}/${openDeliverable.id}`}
          fields={deliverableFields(openDeliverable)}
          open={openDeliverableId !== null}
          onOpenChange={(o) => !o && setOpenDeliverableId(null)}
          onSaved={() => void refetch()}
        />
      )}
      {/* Delete confirm */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" /> Delete deliverable
            </DialogTitle>
            <DialogDescription>
              Permanently delete <span className="font-medium">{deleting?.code}</span> —{" "}
              {deleting?.title}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DeliverableDialog({
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
  form: DeliverableForm;
  setForm: React.Dispatch<React.SetStateAction<DeliverableForm>>;
  branches: BranchLite[];
  pending: boolean;
  onSubmit: () => void;
  submitLabel: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Track CDRL submission dates, status, and government review cycle.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <FormField label="Deliverable title" required>
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
          <FormField label="Description">
            {(p) => (
              <Textarea
                {...p}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Purpose and scope of this deliverable"
                rows={2}
              />
            )}
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Type</label>
              <Select
                value={form.deliverableType}
                onValueChange={(v) => setForm((f) => ({ ...f, deliverableType: v ?? "" }))}
              >
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o} value={o}>{o}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FormField label="CLIN">
              {(p) => (
                <Input
                  {...p}
                  value={form.clin}
                  onChange={(e) => setForm((f) => ({ ...f, clin: e.target.value }))}
                  placeholder="e.g. 0001AA"
                />
              )}
            </FormField>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Branch</label>
              <Select
                value={form.branchId}
                onValueChange={(v) => setForm((f) => ({ ...f, branchId: v ?? "" }))}
              >
                <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.code} {b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Owner">
              {(p) => (
                <Input
                  {...p}
                  value={form.owner}
                  onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
                  placeholder="Accountable person"
                />
              )}
            </FormField>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Status</label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm((f) => ({ ...f, status: (v ?? "NOT_STARTED") as DeliverableStatus }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Due (Projected)">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.baselineDue}
                  onChange={(e) => setForm((f) => ({ ...f, baselineDue: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Internal review date">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.internalReview}
                  onChange={(e) => setForm((f) => ({ ...f, internalReview: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Actual submission">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.actualSubmission}
                  onChange={(e) => setForm((f) => ({ ...f, actualSubmission: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Govt review period (days)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  value={form.govReviewPeriod}
                  onChange={(e) => setForm((f) => ({ ...f, govReviewPeriod: e.target.value }))}
                  placeholder="e.g. 30"
                />
              )}
            </FormField>
            <FormField label="Govt acceptance date">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.govAcceptance}
                  onChange={(e) => setForm((f) => ({ ...f, govAcceptance: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Revision cycle">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  value={form.revisionCycle}
                  onChange={(e) => setForm((f) => ({ ...f, revisionCycle: e.target.value }))}
                  placeholder="0"
                />
              )}
            </FormField>
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-[var(--text)]">
              <input
                type="checkbox"
                checked={form.revRequired}
                onChange={(e) => setForm((f) => ({ ...f, revRequired: e.target.checked }))}
                className="size-4 accent-[var(--primary)]"
              />
              Revision required
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--text)]">
              <input
                type="checkbox"
                checked={form.escalate}
                onChange={(e) => setForm((f) => ({ ...f, escalate: e.target.checked }))}
                className="size-4 accent-[var(--primary)]"
              />
              Escalate to customer (surfaces in the Government view)
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Branch owner">
              {(p) => (
                <Input
                  {...p}
                  value={form.branchOwner}
                  onChange={(e) => setForm((f) => ({ ...f, branchOwner: e.target.value }))}
                  placeholder="Branch-level accountable person"
                />
              )}
            </FormField>
            <FormField label="Work item reference">
              {(p) => (
                <Input
                  {...p}
                  value={form.workItemRef}
                  onChange={(e) => setForm((f) => ({ ...f, workItemRef: e.target.value }))}
                  placeholder="e.g. WI-042 or ticket number"
                />
              )}
            </FormField>
          </div>
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={pending || !form.title.trim()}>
            {pending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TableSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-8 w-36" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
