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
import { Loader2, Plus, Trash2, ShieldOff, AlertTriangle } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";

type BlockerStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "ESCALATED";
type BlockerType =
  | "INTERNAL"
  | "EXTERNAL_GOVERNMENT"
  | "EXTERNAL_PROCUREMENT"
  | "EXTERNAL_THIRD_PARTY";

interface BranchLite {
  id: string;
  code: string;
  name: string;
}

interface Blocker {
  id: string;
  code: string;
  title: string;
  description: string | null;
  type: BlockerType;
  status: BlockerStatus;
  branchId: string | null;
  programBranch: BranchLite | null;
  source: string | null;
  identifiedBy: string | null;
  owner: string | null;
  whatUnblocks: string | null;
  decisionAuthority: string | null;
  relatedRiskCode: string | null;
  customerNotified: boolean;
  customerNotifiedDate: string | null;
  targetDate: string | null;
  escalate: boolean;
  identifiedAt: string;
}

interface BlockerTrackerProps {
  orgId: string;
  projectId: string;
  branches: BranchLite[];
}

const STATUS_OPTIONS: BlockerStatus[] = ["OPEN", "IN_PROGRESS", "RESOLVED", "ESCALATED"];

const TYPE_OPTIONS: { value: BlockerType; label: string }[] = [
  { value: "INTERNAL", label: "Internal" },
  { value: "EXTERNAL_GOVERNMENT", label: "External — Government" },
  { value: "EXTERNAL_PROCUREMENT", label: "External — Procurement" },
  { value: "EXTERNAL_THIRD_PARTY", label: "External — Third Party" },
];

const STATUS_LABEL: Record<BlockerStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
  ESCALATED: "Escalated",
};

const TYPE_LABEL: Record<BlockerType, string> = {
  INTERNAL: "Internal",
  EXTERNAL_GOVERNMENT: "External — Government",
  EXTERNAL_PROCUREMENT: "External — Procurement",
  EXTERNAL_THIRD_PARTY: "External — Third Party",
};

interface BlockerForm {
  title: string;
  description: string;
  type: BlockerType;
  branchId: string;
  source: string;
  identifiedBy: string;
  owner: string;
  whatUnblocks: string;
  decisionAuthority: string;
  relatedRiskCode: string;
  customerNotified: boolean;
  customerNotifiedDate: string;
  targetDate: string;
  escalate: boolean;
  status: BlockerStatus;
}

const emptyForm: BlockerForm = {
  title: "",
  description: "",
  type: "INTERNAL",
  branchId: "",
  source: "",
  identifiedBy: "",
  owner: "",
  whatUnblocks: "",
  decisionAuthority: "",
  relatedRiskCode: "",
  customerNotified: false,
  customerNotifiedDate: "",
  targetDate: "",
  escalate: false,
  status: "OPEN",
};

function toDateInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

function blockerToForm(b: Blocker): BlockerForm {
  return {
    title: b.title,
    description: b.description ?? "",
    type: b.type,
    branchId: b.branchId ?? "",
    source: b.source ?? "",
    identifiedBy: b.identifiedBy ?? "",
    owner: b.owner ?? "",
    whatUnblocks: b.whatUnblocks ?? "",
    decisionAuthority: b.decisionAuthority ?? "",
    relatedRiskCode: b.relatedRiskCode ?? "",
    customerNotified: b.customerNotified,
    customerNotifiedDate: toDateInput(b.customerNotifiedDate),
    targetDate: toDateInput(b.targetDate),
    escalate: b.escalate,
    status: b.status,
  };
}

function formToBody(f: BlockerForm) {
  return {
    title: f.title.trim(),
    description: f.description.trim() || null,
    type: f.type,
    branchId: f.branchId || null,
    source: f.source.trim() || null,
    identifiedBy: f.identifiedBy.trim() || null,
    owner: f.owner.trim() || null,
    whatUnblocks: f.whatUnblocks.trim() || null,
    decisionAuthority: f.decisionAuthority.trim() || null,
    relatedRiskCode: f.relatedRiskCode.trim() || null,
    customerNotified: f.customerNotified,
    customerNotifiedDate: f.customerNotifiedDate ? new Date(f.customerNotifiedDate).toISOString() : null,
    targetDate: f.targetDate ? new Date(f.targetDate).toISOString() : null,
    escalate: f.escalate,
    status: f.status,
  };
}

function daysOpen(b: Blocker, nowMs: number): string {
  if (b.status === "RESOLVED") return "—";
  return String(Math.floor((nowMs - new Date(b.identifiedAt).getTime()) / 86400000));
}

type SortKey = "code" | "status" | "days";

export function BlockerTracker({ orgId, projectId, branches }: BlockerTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/blockers`;
  const queryKey = useOrgQueryKey("blockers", projectId);
  const { data: blockers = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<Blocker[]>(apiBase),
  });
  const canEdit = usePermissions().can(Permission.PROJECT_UPDATE);

  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("code");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Blocker | null>(null);
  const [deleting, setDeleting] = useState<Blocker | null>(null);
  const [form, setForm] = useState<BlockerForm>(emptyForm);
  // Snapshot "now" once at mount so days-open is stable across re-renders (React purity).
  const [nowMs] = useState(() => Date.now());

  const createMutation = useOrgMutation<Blocker, Error, BlockerForm>({
    mutationFn: (f) => jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["blockers", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the blocker."),
  });
  const updateMutation = useOrgMutation<Blocker, Error, { id: string; f: BlockerForm }>({
    mutationFn: ({ id, f }) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["blockers", projectId]],
    onSuccess: () => setEditing(null),
    onError: (e) => notifyError(e, "Couldn't update the blocker."),
  });
  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["blockers", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the blocker."),
  });

  const view = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const rows = f
      ? blockers.filter(
          (b) =>
            b.title.toLowerCase().includes(f) ||
            b.code.toLowerCase().includes(f) ||
            (b.owner ?? "").toLowerCase().includes(f) ||
            (b.programBranch?.name ?? "").toLowerCase().includes(f),
        )
      : blockers.slice();
    rows.sort((a, b) => {
      if (sort === "code") return a.code.localeCompare(b.code);
      if (sort === "status") return a.status.localeCompare(b.status);
      // days: resolved last (—), otherwise sort descending by days open
      const da = a.status === "RESOLVED" ? -1 : Math.floor((nowMs - new Date(a.identifiedAt).getTime()) / 86400000);
      const db = b.status === "RESOLVED" ? -1 : Math.floor((nowMs - new Date(b.identifiedAt).getTime()) / 86400000);
      return db - da;
    });
    return rows;
  }, [blockers, filter, sort, nowMs]);

  function openCreate() {
    setForm({ ...emptyForm, branchId: branches[0]?.id ?? "" });
    setCreateOpen(true);
  }
  function openEdit(b: Blocker) {
    setForm(blockerToForm(b));
    setEditing(b);
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load blockers" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">Blocked Items</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {blockers.length} blocker{blockers.length === 1 ? "" : "s"}
          </p>
        </div>
        {canEdit && (
          <Button onClick={openCreate}>
            <Plus className="size-4" /> New Blocker
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title, ID, owner, branch…"
          className="max-w-xs"
        />
        <Select value={sort} onValueChange={(v) => setSort((v ?? "code") as SortKey)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="code">Sort: Blocker ID</SelectItem>
            <SelectItem value="status">Sort: Status</SelectItem>
            <SelectItem value="days">Sort: Days Open</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {view.length === 0 ? (
        <EmptyState
          icon={ShieldOff}
          title={filter ? "No matching blockers" : "No blockers yet"}
          description={filter ? "Try a different filter." : "Log the first blocker to start tracking."}
          action={!filter && canEdit ? <Button onClick={openCreate}><Plus className="size-4" /> New Blocker</Button> : undefined}
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
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Esc.</th>
                <th className="px-3 py-2 text-right font-medium">Days Open</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {view.map((b) => (
                <tr
                  key={b.id}
                  className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)]${canEdit ? " cursor-pointer" : ""}`}
                  onClick={canEdit ? () => openEdit(b) : undefined}
                >
                  <td className="px-3 py-2 font-mono text-xs text-[var(--text-muted)]">{b.code}</td>
                  <td className="max-w-xs truncate px-3 py-2 text-[var(--text)]">{b.title}</td>
                  <td className="px-3 py-2 text-xs text-[var(--text-muted)]">
                    {b.programBranch?.code ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--text-muted)]">{TYPE_LABEL[b.type]}</td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">{STATUS_LABEL[b.status]}</td>
                  <td className="px-3 py-2">
                    {b.escalate ? (
                      <span className="text-[10px] font-semibold uppercase text-[var(--status-blocked,#dc2626)]">
                        Yes
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text)]">{daysOpen(b, nowMs)}</td>
                  <td className="px-2 py-2 text-right">
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete blocker"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(b);
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
      <BlockerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New Blocker"
        form={form}
        setForm={setForm}
        branches={branches}
        pending={createMutation.isPending}
        onSubmit={() => createMutation.mutate(form)}
        submitLabel="Create"
      />
      {/* Edit */}
      <BlockerDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing ? `Edit ${editing.code}` : "Edit Blocker"}
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
              <AlertTriangle className="size-5 text-destructive" /> Delete blocker
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

function BlockerDialog({
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
  form: BlockerForm;
  setForm: React.Dispatch<React.SetStateAction<BlockerForm>>;
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
            Track the item blocking progress and the path to resolution.
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
                placeholder="What is blocking progress?"
                rows={2}
              />
            )}
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {/* Type */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Type</label>
              <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: (v ?? "INTERNAL") as BlockerType }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Branch */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Branch</label>
              <Select value={form.branchId} onValueChange={(v) => setForm((f) => ({ ...f, branchId: v ?? "" }))}>
                <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.code} {b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Status */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Status</label>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: (v ?? "OPEN") as BlockerStatus }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o} value={o}>{STATUS_LABEL[o]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Source">
              {(p) => (
                <Input {...p} value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} placeholder="Origin of the blocker" />
              )}
            </FormField>
            <FormField label="Identified by">
              {(p) => (
                <Input {...p} value={form.identifiedBy} onChange={(e) => setForm((f) => ({ ...f, identifiedBy: e.target.value }))} placeholder="Who identified it" />
              )}
            </FormField>
            <FormField label="Owner">
              {(p) => (
                <Input {...p} value={form.owner} onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))} placeholder="Accountable person" />
              )}
            </FormField>
            <FormField label="Decision authority">
              {(p) => (
                <Input {...p} value={form.decisionAuthority} onChange={(e) => setForm((f) => ({ ...f, decisionAuthority: e.target.value }))} placeholder="Who can resolve it" />
              )}
            </FormField>
          </div>

          <FormField label="What unblocks this">
            {(p) => (
              <Textarea
                {...p}
                value={form.whatUnblocks}
                onChange={(e) => setForm((f) => ({ ...f, whatUnblocks: e.target.value }))}
                placeholder="Describe what action or decision removes this blocker"
                rows={2}
              />
            )}
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="Related risk code">
              {(p) => (
                <Input {...p} value={form.relatedRiskCode} onChange={(e) => setForm((f) => ({ ...f, relatedRiskCode: e.target.value }))} placeholder="e.g. R-001" />
              )}
            </FormField>
            <FormField label="Target resolution">
              {(p) => (
                <Input {...p} type="date" value={form.targetDate} onChange={(e) => setForm((f) => ({ ...f, targetDate: e.target.value }))} />
              )}
            </FormField>
            <FormField label="Customer notified date">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.customerNotifiedDate}
                  onChange={(e) => setForm((f) => ({ ...f, customerNotifiedDate: e.target.value }))}
                  disabled={!form.customerNotified}
                />
              )}
            </FormField>
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-[var(--text)]">
              <input
                type="checkbox"
                checked={form.customerNotified}
                onChange={(e) => setForm((f) => ({ ...f, customerNotified: e.target.checked, customerNotifiedDate: e.target.checked ? f.customerNotifiedDate : "" }))}
                className="size-4 accent-[var(--primary)]"
              />
              Customer notified
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--text)]">
              <input
                type="checkbox"
                checked={form.escalate}
                onChange={(e) => setForm((f) => ({ ...f, escalate: e.target.checked }))}
                className="size-4 accent-[var(--primary)]"
              />
              Escalate (surfaces in the Government view)
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
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
