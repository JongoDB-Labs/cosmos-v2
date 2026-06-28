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
import { Loader2, Plus, Trash2, FileText, AlertTriangle } from "lucide-react";

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
};

function toDateInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

function deliverableToForm(d: Deliverable): DeliverableForm {
  return {
    title: d.title,
    description: d.description ?? "",
    deliverableType: d.deliverableType ?? "Report",
    clin: d.clin ?? "",
    branchId: d.branchId ?? "",
    owner: d.owner ?? "",
    baselineDue: toDateInput(d.baselineDue),
    internalReview: toDateInput(d.internalReview),
    actualSubmission: toDateInput(d.actualSubmission),
    govReviewPeriod: d.govReviewPeriod != null ? String(d.govReviewPeriod) : "",
    govAcceptance: toDateInput(d.govAcceptance),
    revisionCycle: d.revisionCycle != null ? String(d.revisionCycle) : "",
    revRequired: d.revRequired,
    escalate: d.escalate,
    status: d.status,
  };
}

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

type SortKey = "baselineDue" | "status" | "code";

export function DeliverableTracker({ orgId, projectId, branches }: DeliverableTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/deliverables`;
  const queryKey = useOrgQueryKey("deliverables", projectId);
  const { data: deliverables = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<Deliverable[]>(apiBase),
  });

  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("baselineDue");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Deliverable | null>(null);
  const [deleting, setDeleting] = useState<Deliverable | null>(null);
  const [form, setForm] = useState<DeliverableForm>(emptyForm);

  const createMutation = useOrgMutation<Deliverable, Error, DeliverableForm>({
    mutationFn: (f) => jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["deliverables", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the deliverable."),
  });
  const updateMutation = useOrgMutation<Deliverable, Error, { id: string; f: DeliverableForm }>({
    mutationFn: ({ id, f }) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["deliverables", projectId]],
    onSuccess: () => setEditing(null),
    onError: (e) => notifyError(e, "Couldn't update the deliverable."),
  });
  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["deliverables", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the deliverable."),
  });

  const view = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const rows = f
      ? deliverables.filter(
          (d) =>
            d.title.toLowerCase().includes(f) ||
            d.code.toLowerCase().includes(f) ||
            (d.clin ?? "").toLowerCase().includes(f) ||
            (d.owner ?? "").toLowerCase().includes(f) ||
            (d.programBranch?.name ?? "").toLowerCase().includes(f),
        )
      : deliverables.slice();
    rows.sort((a, b) => {
      if (sort === "baselineDue") {
        const aDate = a.baselineDue ? new Date(a.baselineDue).getTime() : Infinity;
        const bDate = b.baselineDue ? new Date(b.baselineDue).getTime() : Infinity;
        return aDate - bDate;
      }
      if (sort === "status") return a.status.localeCompare(b.status);
      return a.code.localeCompare(b.code);
    });
    return rows;
  }, [deliverables, filter, sort]);

  function openCreate() {
    setForm({ ...emptyForm, branchId: branches[0]?.id ?? "" });
    setCreateOpen(true);
  }
  function openEdit(d: Deliverable) {
    setForm(deliverableToForm(d));
    setEditing(d);
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load deliverables" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">Deliverable Register</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {deliverables.length} deliverable{deliverables.length === 1 ? "" : "s"} · CDRL tracking
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" /> New Deliverable
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title, ID, CLIN, owner, branch…"
          className="max-w-xs"
        />
        <Select value={sort} onValueChange={(v) => setSort((v ?? "baselineDue") as SortKey)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="baselineDue">Sort: Baseline Due</SelectItem>
            <SelectItem value="status">Sort: Status</SelectItem>
            <SelectItem value="code">Sort: CDRL ID</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {view.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={filter ? "No matching deliverables" : "No deliverables yet"}
          description={filter ? "Try a different filter." : "Log the first deliverable to start tracking CDRLs."}
          action={!filter ? <Button onClick={openCreate}><Plus className="size-4" /> New Deliverable</Button> : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-3 py-2 font-medium">ID</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">CLIN</th>
                <th className="px-3 py-2 font-medium">Branch</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Baseline Due</th>
                <th className="px-3 py-2 font-medium">Early/Late</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {view.map((d) => {
                const earlyLate = computeEarlyLate(d.baselineDue, d.actualSubmission);
                const isLate = earlyLate.endsWith("d late");
                const isEarly = earlyLate.endsWith("d early");
                return (
                  <tr
                    key={d.id}
                    className="cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)]"
                    onClick={() => openEdit(d)}
                  >
                    <td className="px-3 py-2 font-mono text-xs text-[var(--text-muted)]">{d.code}</td>
                    <td className="max-w-xs truncate px-3 py-2 text-[var(--text)]">{d.title}</td>
                    <td className="px-3 py-2 text-xs text-[var(--text-muted)]">{d.clin ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-[var(--text-muted)]">
                      {d.programBranch?.code ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">{STATUS_LABEL[d.status]}</td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">
                      {d.baselineDue ? new Date(d.baselineDue).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span
                        className={
                          isLate
                            ? "font-medium text-[var(--status-blocked,#dc2626)]"
                            : isEarly
                              ? "font-medium text-[var(--status-ok,#16a34a)]"
                              : "text-[var(--text-muted)]"
                        }
                      >
                        {earlyLate}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete deliverable"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(d);
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
      {/* Edit */}
      <DeliverableDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing ? `Edit ${editing.code}` : "Edit Deliverable"}
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
    </div>
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
            <FormField label="Baseline due">
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
