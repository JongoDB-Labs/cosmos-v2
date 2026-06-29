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
import { Loader2, Plus, Trash2, AlertTriangle, ClipboardList } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { PmEntityDrawer, type PmField } from "@/components/pm-dashboard/pm-entity-drawer";

type ChangeRequestStatus =
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "IMPLEMENTED"
  | "WITHDRAWN";

interface BranchLite {
  id: string;
  code: string;
  name: string;
}

interface ChangeRequest {
  id: string;
  code: string;
  title: string;
  description: string | null;
  type: string | null;
  branchId: string | null;
  programBranch: BranchLite | null;
  initiatedBy: string | null;
  decisionAuthority: string | null;
  approvedBy: string | null;
  costImpact: number | null;
  scheduleDaysImpact: number | null;
  modRequired: boolean;
  modNumber: string | null;
  implDate: string | null;
  relatedRiskCode: string | null;
  status: ChangeRequestStatus;
  submittedDate: string | null;
  scopeImpact: string | null;
  notes: string | null;
}

interface ChangeTrackerProps {
  orgId: string;
  projectId: string;
  branches: BranchLite[];
}

const STATUS_OPTIONS: ChangeRequestStatus[] = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "IMPLEMENTED",
  "WITHDRAWN",
];

const TYPE_OPTIONS = [
  "Scope",
  "Schedule",
  "Cost",
  "Technical",
  "Contractual",
  "Administrative",
];

const STATUS_LABEL: Record<ChangeRequestStatus, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under Review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  IMPLEMENTED: "Implemented",
  WITHDRAWN: "Withdrawn",
};

const STATUS_COLOR: Record<ChangeRequestStatus, string> = {
  SUBMITTED: "var(--text-muted, #6b7280)",
  UNDER_REVIEW: "var(--status-warn, #d97706)",
  APPROVED: "#16a34a",
  REJECTED: "var(--status-blocked, #dc2626)",
  IMPLEMENTED: "#2563eb",
  WITHDRAWN: "var(--text-muted, #6b7280)",
};

interface ChangeForm {
  title: string;
  description: string;
  type: string;
  branchId: string;
  initiatedBy: string;
  decisionAuthority: string;
  approvedBy: string;
  costImpact: string;
  scheduleDaysImpact: string;
  modRequired: boolean;
  modNumber: string;
  implDate: string;
  relatedRiskCode: string;
  status: ChangeRequestStatus;
  submittedDate: string;
  scopeImpact: string;
  notes: string;
}

const emptyForm: ChangeForm = {
  title: "",
  description: "",
  type: "Scope",
  branchId: "",
  initiatedBy: "",
  decisionAuthority: "",
  approvedBy: "",
  costImpact: "",
  scheduleDaysImpact: "",
  modRequired: false,
  modNumber: "",
  implDate: "",
  relatedRiskCode: "",
  status: "SUBMITTED",
  submittedDate: "",
  scopeImpact: "",
  notes: "",
};

function formToBody(f: ChangeForm) {
  return {
    title: f.title.trim(),
    description: f.description.trim() || null,
    type: f.type || null,
    branchId: f.branchId || null,
    initiatedBy: f.initiatedBy.trim() || null,
    decisionAuthority: f.decisionAuthority.trim() || null,
    approvedBy: f.approvedBy.trim() || null,
    costImpact: f.costImpact !== "" ? Number(f.costImpact) : null,
    scheduleDaysImpact: f.scheduleDaysImpact !== "" ? Number(f.scheduleDaysImpact) : null,
    modRequired: f.modRequired,
    modNumber: f.modNumber.trim() || null,
    implDate: f.implDate ? new Date(f.implDate).toISOString() : null,
    relatedRiskCode: f.relatedRiskCode.trim() || null,
    status: f.status,
    submittedDate: f.submittedDate ? new Date(f.submittedDate).toISOString() : null,
    scopeImpact: f.scopeImpact.trim() || null,
    notes: f.notes.trim() || null,
  };
}

type SortKey = "code" | "status" | "cost";

export function ChangeTracker({ orgId, projectId, branches }: ChangeTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/changes`;
  const queryKey = useOrgQueryKey("changes", projectId);
  const { data: changes = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<ChangeRequest[]>(apiBase),
  });
  const canEdit = usePermissions().can(Permission.PROJECT_UPDATE);

  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("code");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<ChangeRequest | null>(null);
  const [form, setForm] = useState<ChangeForm>(emptyForm);
  // The drawer is the primary row-detail view. We hold the open change's id so the
  // drawer's fields rebuild from the freshest cached row after an inline PATCH.
  const [openChangeId, setOpenChangeId] = useState<string | null>(null);
  const openChange = openChangeId ? changes.find((c) => c.id === openChangeId) ?? null : null;

  const createMutation = useOrgMutation<ChangeRequest, Error, ChangeForm>({
    mutationFn: (f) => jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["changes", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the change request."),
  });
  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["changes", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the change request."),
  });

  const view = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const rows = f
      ? changes.filter(
          (c) =>
            c.title.toLowerCase().includes(f) ||
            c.code.toLowerCase().includes(f) ||
            (c.initiatedBy ?? "").toLowerCase().includes(f) ||
            (c.programBranch?.name ?? "").toLowerCase().includes(f),
        )
      : changes.slice();
    rows.sort((a, b) => {
      if (sort === "code") return a.code.localeCompare(b.code);
      if (sort === "status") return a.status.localeCompare(b.status);
      // cost descending (nulls last)
      const ca = a.costImpact ?? -Infinity;
      const cb = b.costImpact ?? -Infinity;
      return cb - ca;
    });
    return rows;
  }, [changes, filter, sort]);

  function openCreate() {
    setForm({ ...emptyForm, branchId: branches[0]?.id ?? "" });
    setCreateOpen(true);
  }

  // Build the drawer's inline-editable field list for the open change request.
  // Mirrors the fields the edit dialog used to cover; each persists a single-key
  // PATCH to the changes endpoint.
  function changeFields(c: ChangeRequest): PmField[] {
    return [
      { key: "title", label: "Title", type: "text", value: c.title, editable: canEdit },
      {
        key: "description",
        label: "Description",
        type: "textarea",
        value: c.description,
        editable: canEdit,
        placeholder: "Background, rationale, and expected impact",
      },
      {
        key: "type",
        label: "Type",
        type: "select",
        value: c.type,
        editable: canEdit,
        options: TYPE_OPTIONS.map((o) => ({ value: o, label: o })),
      },
      {
        key: "branchId",
        label: "Branch",
        type: "select",
        value: c.branchId,
        editable: canEdit && branches.length > 0,
        options: branches.map((b) => ({ value: b.id, label: `${b.code} ${b.name}` })),
        placeholder: "Select branch",
      },
      {
        key: "status",
        label: "Status",
        type: "select",
        value: c.status,
        editable: canEdit,
        options: STATUS_OPTIONS.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
      },
      { key: "initiatedBy", label: "Initiated by", type: "text", value: c.initiatedBy, editable: canEdit },
      {
        key: "decisionAuthority",
        label: "Decision authority",
        type: "text",
        value: c.decisionAuthority,
        editable: canEdit,
      },
      { key: "approvedBy", label: "Approved by", type: "text", value: c.approvedBy, editable: canEdit },
      {
        key: "costImpact",
        label: "Cost impact ($)",
        type: "number",
        value: c.costImpact,
        editable: canEdit,
      },
      {
        key: "scheduleDaysImpact",
        label: "Schedule impact (days)",
        type: "number",
        value: c.scheduleDaysImpact,
        editable: canEdit,
      },
      { key: "modNumber", label: "MOD number", type: "text", value: c.modNumber, editable: canEdit },
      {
        key: "modRequired",
        label: "MOD required",
        type: "select",
        value: c.modRequired ? "true" : "false",
        editable: canEdit,
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
        coerce: (v) => v === "true",
      },
      { key: "implDate", label: "Implementation date", type: "date", value: c.implDate, editable: canEdit },
      { key: "submittedDate", label: "Submitted date", type: "date", value: c.submittedDate, editable: canEdit },
      {
        key: "relatedRiskCode",
        label: "Related risk ID",
        type: "text",
        value: c.relatedRiskCode,
        editable: canEdit,
      },
      { key: "scopeImpact", label: "Scope impact", type: "text", value: c.scopeImpact, editable: canEdit },
      {
        key: "notes",
        label: "Notes",
        type: "textarea",
        value: c.notes,
        editable: canEdit,
        placeholder: "Additional notes",
      },
    ];
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load change requests" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">Change Log</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {changes.length} change request{changes.length === 1 ? "" : "s"}
          </p>
        </div>
        {canEdit && (
          <Button onClick={openCreate}>
            <Plus className="size-4" /> New Change Request
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title, ID, initiator, branch…"
          className="max-w-xs"
        />
        <Select value={sort} onValueChange={(v) => setSort((v ?? "code") as SortKey)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="code">Sort: CR ID</SelectItem>
            <SelectItem value="status">Sort: Status</SelectItem>
            <SelectItem value="cost">Sort: Cost Impact</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {view.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={filter ? "No matching change requests" : "No change requests yet"}
          description={
            filter ? "Try a different filter." : "Log the first change request to start the register."
          }
          action={
            !filter && canEdit ? (
              <Button onClick={openCreate}>
                <Plus className="size-4" /> New Change Request
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-3 py-2 font-medium">ID</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Branch</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 text-right font-medium">Cost ($)</th>
                <th className="px-3 py-2 text-right font-medium">Sched (days)</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {view.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)]"
                  onClick={() => setOpenChangeId(c.id)}
                >
                  <td className="px-3 py-2 font-mono text-xs text-[var(--text-muted)]">{c.code}</td>
                  <td className="max-w-xs truncate px-3 py-2 text-[var(--text)]">{c.title}</td>
                  <td className="px-3 py-2 text-xs text-[var(--text-muted)]">
                    {c.programBranch?.code ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--text-muted)]">{c.type ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text)]">
                    {c.costImpact != null
                      ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(c.costImpact))
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text)]">
                    {c.scheduleDaysImpact != null ? c.scheduleDaysImpact : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={c.status} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete change request"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(c);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create */}
      <ChangeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New Change Request"
        form={form}
        setForm={setForm}
        branches={branches}
        pending={createMutation.isPending}
        onSubmit={() => createMutation.mutate(form)}
        submitLabel="Create"
      />
      {/* Detail drawer — issue-style: inline-editable fields + Comments + Activity.
          Replaces the old edit dialog as the primary row-detail view. */}
      {openChange && (
        <PmEntityDrawer
          key={openChange.id}
          orgId={orgId}
          projectId={projectId}
          subjectType="change"
          subjectId={openChange.id}
          title={openChange.title}
          code={openChange.code}
          patchPath={`${apiBase}/${openChange.id}`}
          fields={changeFields(openChange)}
          open={openChangeId !== null}
          onOpenChange={(o) => !o && setOpenChangeId(null)}
          onSaved={() => void refetch()}
        />
      )}
      {/* Delete confirm */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" /> Delete change request
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

function ChangeDialog({
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
  form: ChangeForm;
  setForm: React.Dispatch<React.SetStateAction<ChangeForm>>;
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
            Track scope, schedule, cost, and contractual changes to the program.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <FormField label="Title" required>
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
                placeholder="Background, rationale, and expected impact"
                rows={2}
              />
            )}
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <PickField
              label="Type"
              value={form.type}
              onChange={(v) => setForm((f) => ({ ...f, type: v }))}
              options={TYPE_OPTIONS}
            />
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
            <PickField
              label="Status"
              value={form.status}
              onChange={(v) => setForm((f) => ({ ...f, status: v as ChangeRequestStatus }))}
              options={STATUS_OPTIONS}
              labelFor={(v) => STATUS_LABEL[v as ChangeRequestStatus]}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="Initiated by">
              {(p) => (
                <Input
                  {...p}
                  value={form.initiatedBy}
                  onChange={(e) => setForm((f) => ({ ...f, initiatedBy: e.target.value }))}
                  placeholder="Requestor name"
                />
              )}
            </FormField>
            <FormField label="Decision authority">
              {(p) => (
                <Input
                  {...p}
                  value={form.decisionAuthority}
                  onChange={(e) => setForm((f) => ({ ...f, decisionAuthority: e.target.value }))}
                  placeholder="Approving authority"
                />
              )}
            </FormField>
            <FormField label="Approved by">
              {(p) => (
                <Input
                  {...p}
                  value={form.approvedBy}
                  onChange={(e) => setForm((f) => ({ ...f, approvedBy: e.target.value }))}
                  placeholder="Name of approver"
                />
              )}
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Cost impact ($)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  value={form.costImpact}
                  onChange={(e) => setForm((f) => ({ ...f, costImpact: e.target.value }))}
                  placeholder="0"
                />
              )}
            </FormField>
            <FormField label="Schedule impact (days)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  value={form.scheduleDaysImpact}
                  onChange={(e) => setForm((f) => ({ ...f, scheduleDaysImpact: e.target.value }))}
                  placeholder="0"
                />
              )}
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="MOD number">
              {(p) => (
                <Input
                  {...p}
                  value={form.modNumber}
                  onChange={(e) => setForm((f) => ({ ...f, modNumber: e.target.value }))}
                  placeholder="e.g. P00003"
                />
              )}
            </FormField>
            <FormField label="Implementation date">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.implDate}
                  onChange={(e) => setForm((f) => ({ ...f, implDate: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Related risk ID">
              {(p) => (
                <Input
                  {...p}
                  value={form.relatedRiskCode}
                  onChange={(e) => setForm((f) => ({ ...f, relatedRiskCode: e.target.value }))}
                  placeholder="e.g. R-001"
                />
              )}
            </FormField>
          </div>

          <label className="flex items-center gap-2 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={form.modRequired}
              onChange={(e) => setForm((f) => ({ ...f, modRequired: e.target.checked }))}
              className="size-4 accent-[var(--primary)]"
            />
            MOD required (contract modification needed)
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Submitted date">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.submittedDate}
                  onChange={(e) => setForm((f) => ({ ...f, submittedDate: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Scope impact">
              {(p) => (
                <Input
                  {...p}
                  value={form.scopeImpact}
                  onChange={(e) => setForm((f) => ({ ...f, scopeImpact: e.target.value }))}
                  placeholder="Describe scope impact"
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

function PickField({
  label,
  value,
  onChange,
  options,
  labelFor,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  labelFor?: (v: string) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {labelFor ? labelFor(o) : o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function StatusPill({ status }: { status: ChangeRequestStatus }) {
  const label = STATUS_LABEL[status];
  const color = STATUS_COLOR[status];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {label}
    </span>
  );
}

function TableSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-8 w-36" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
