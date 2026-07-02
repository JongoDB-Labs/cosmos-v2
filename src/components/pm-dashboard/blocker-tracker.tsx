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
import { Loader2, Trash2, ShieldOff, AlertTriangle, Eye, Flag, CircleDot } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { PmEntityDrawer, type PmField } from "@/components/pm-dashboard/pm-entity-drawer";
import { PmDataTable } from "@/components/pm-dashboard/pm-data-table";
import { bulkFanOut } from "@/lib/pm/bulk";
import type { ActionMenuGroup } from "@/components/ui/action-menu";

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
  relatedRef: string | null;
  notes: string | null;
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

// Register-severity order for status sorting (escalated/open first, resolved last).
const STATUS_RANK: Record<BlockerStatus, number> = {
  ESCALATED: 0,
  OPEN: 1,
  IN_PROGRESS: 2,
  RESOLVED: 3,
};

// Snapshot "now" once at module load so days-open is stable across re-renders
// (React purity) without threading component state into the module-level columns.
const NOW_MS = Date.now();

// Numeric days-open, or null when resolved (rendered as "—", sorted last).
function daysOpenNum(b: Blocker): number | null {
  if (b.status === "RESOLVED") return null;
  return Math.floor((NOW_MS - new Date(b.identifiedAt).getTime()) / 86400000);
}
function daysOpenLabel(b: Blocker): string {
  const n = daysOpenNum(b);
  return n === null ? "—" : String(n);
}

// Sortable columns (headers sort on click via the shared DataTable). Pure — no
// component state, so defined at module scope.
const BLOCKER_COLUMNS: ColumnDef<Blocker>[] = [
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
    id: "branch",
    header: "Branch",
    accessorFn: (b) => b.programBranch?.code ?? "",
    cell: ({ row }) => <span className="text-xs text-[var(--text-muted)]">{row.original.programBranch?.code ?? "—"}</span>,
  },
  {
    id: "type",
    header: "Type",
    accessorFn: (b) => TYPE_LABEL[b.type],
    cell: ({ row }) => <span className="text-xs text-[var(--text-muted)]">{TYPE_LABEL[row.original.type]}</span>,
  },
  {
    accessorKey: "status",
    header: "Status",
    sortingFn: (a, b) => STATUS_RANK[a.original.status] - STATUS_RANK[b.original.status],
    cell: ({ row }) => <span className="text-[var(--text-muted)]">{STATUS_LABEL[row.original.status]}</span>,
  },
  {
    id: "escalate",
    header: "Esc.",
    accessorFn: (b) => (b.escalate ? 1 : 0),
    cell: ({ row }) =>
      row.original.escalate ? (
        <span className="text-[10px] font-semibold uppercase text-[var(--status-blocked,#dc2626)]">Yes</span>
      ) : (
        <span className="text-xs text-[var(--text-muted)]">—</span>
      ),
  },
  {
    id: "days",
    header: "Days Open",
    accessorFn: (b) => daysOpenNum(b) ?? -1,
    sortingFn: (a, b) => (daysOpenNum(a.original) ?? -1) - (daysOpenNum(b.original) ?? -1),
    cell: ({ row }) => <span className="tabular-nums text-[var(--text)]">{daysOpenLabel(row.original)}</span>,
  },
];

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
  relatedRef: string;
  notes: string;
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
  relatedRef: "",
  notes: "",
};

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
    relatedRef: f.relatedRef.trim() || null,
    notes: f.notes.trim() || null,
  };
}

export function BlockerTracker({ orgId, projectId, branches }: BlockerTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/blockers`;
  const queryKey = useOrgQueryKey("blockers", projectId);
  const { data: blockers = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<Blocker[]>(apiBase),
  });
  const canEdit = usePermissions().can(Permission.PROJECT_UPDATE);

  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<Blocker | null>(null);
  const [form, setForm] = useState<BlockerForm>(emptyForm);
  // The drawer is the primary row-detail view. We hold the open blocker's id so
  // the drawer's fields rebuild from the freshest cached row after an inline PATCH.
  const [openBlockerId, setOpenBlockerId] = useState<string | null>(null);
  const openBlocker = openBlockerId ? blockers.find((b) => b.id === openBlockerId) ?? null : null;

  const createMutation = useOrgMutation<Blocker, Error, BlockerForm>({
    mutationFn: (f) => jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["blockers", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the blocker."),
  });
  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["blockers", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the blocker."),
  });

  const patch = useCallback(
    (id: string, body: Record<string, unknown>) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    [apiBase],
  );

  // Right-click / ⋯ row menu: view+edit, quick status, escalate toggle, delete.
  const rowActions = useCallback(
    (b: Blocker): ActionMenuGroup[] => {
      const groups: ActionMenuGroup[] = [
        { items: [{ label: "View / edit", icon: Eye, onClick: () => setOpenBlockerId(b.id) }] },
      ];
      if (canEdit) {
        groups.push({
          label: "Set status",
          items: STATUS_OPTIONS.map((st) => ({
            label: STATUS_LABEL[st],
            icon: CircleDot,
            onClick: async () => {
              try {
                await patch(b.id, { status: st });
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
              label: b.escalate ? "Remove escalation" : "Escalate to customer",
              icon: Flag,
              onClick: async () => {
                try {
                  await patch(b.id, { escalate: !b.escalate });
                  void refetch();
                } catch (e) {
                  notifyError(e, "Couldn't update escalation.");
                }
              },
            },
          ],
        });
        groups.push({ items: [{ label: "Delete", icon: Trash2, variant: "destructive", onClick: () => setDeleting(b) }] });
      }
      return groups;
    },
    [canEdit, patch, refetch],
  );

  function openCreate() {
    setForm({ ...emptyForm, branchId: branches[0]?.id ?? "" });
    setCreateOpen(true);
  }
  // Row click → open the detail drawer (the primary row-detail view).
  function openDetail(b: Blocker) {
    setOpenBlockerId(b.id);
  }

  // Build the drawer's inline-editable field list for the open blocker. Each
  // editable field PATCHes the blocker endpoint by key; identifiedAt and
  // days-open are derived and already shown in the table, so they're omitted.
  function blockerFields(b: Blocker): PmField[] {
    return [
      { key: "title", label: "Title", type: "text", value: b.title, editable: canEdit },
      {
        key: "description",
        label: "Description",
        type: "textarea",
        value: b.description,
        editable: canEdit,
        placeholder: "What is blocking progress?",
      },
      {
        key: "type",
        label: "Type",
        type: "select",
        value: b.type,
        editable: canEdit,
        options: TYPE_OPTIONS,
      },
      {
        key: "status",
        label: "Status",
        type: "select",
        value: b.status,
        editable: canEdit,
        options: STATUS_OPTIONS.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
      },
      {
        key: "branchId",
        label: "Branch",
        type: "select",
        value: b.branchId,
        editable: canEdit && branches.length > 0,
        options: branches.map((br) => ({ value: br.id, label: `${br.code} ${br.name}` })),
        placeholder: "Select branch",
      },
      { key: "source", label: "Source", type: "text", value: b.source, editable: canEdit },
      {
        key: "identifiedBy",
        label: "Identified by",
        type: "text",
        value: b.identifiedBy,
        editable: canEdit,
      },
      { key: "owner", label: "Owner", type: "text", value: b.owner, editable: canEdit },
      {
        key: "decisionAuthority",
        label: "Decision authority",
        type: "text",
        value: b.decisionAuthority,
        editable: canEdit,
      },
      {
        key: "whatUnblocks",
        label: "What unblocks this",
        type: "textarea",
        value: b.whatUnblocks,
        editable: canEdit,
        placeholder: "Describe what action or decision removes this blocker",
      },
      {
        key: "relatedRiskCode",
        label: "Related risk code",
        type: "text",
        value: b.relatedRiskCode,
        editable: canEdit,
        placeholder: "e.g. R-001",
      },
      {
        key: "relatedRef",
        label: "Related reference",
        type: "text",
        value: b.relatedRef,
        editable: canEdit,
        placeholder: "e.g. ticket, contract section, or risk ID",
      },
      {
        key: "targetDate",
        label: "Target resolution",
        type: "date",
        value: b.targetDate,
        editable: canEdit,
      },
      {
        key: "customerNotified",
        label: "Customer notified",
        type: "select",
        value: b.customerNotified ? "true" : "false",
        editable: canEdit,
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
        coerce: (v) => v === "true",
      },
      {
        key: "customerNotifiedDate",
        label: "Customer notified date",
        type: "date",
        value: b.customerNotifiedDate,
        editable: canEdit,
      },
      {
        key: "escalate",
        label: "Escalate to customer",
        type: "select",
        value: b.escalate ? "true" : "false",
        editable: canEdit,
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
        coerce: (v) => v === "true",
      },
      {
        key: "notes",
        label: "Notes",
        type: "textarea",
        value: b.notes,
        editable: canEdit,
        placeholder: "Additional notes",
      },
    ];
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load blockers" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <>
      <PmDataTable
        title="Blocked Items"
        subtitle={`${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`}
        rows={blockers}
        columns={BLOCKER_COLUMNS}
        search={filter}
        onSearchChange={setFilter}
        searchText={(b) => [b.code, b.title, b.owner ?? "", b.programBranch?.name ?? ""].join(" ")}
        searchPlaceholder="Filter by title, ID, owner, branch…"
        onRowClick={openDetail}
        rowActions={rowActions}
        onNew={canEdit ? openCreate : undefined}
        newLabel="New Blocker"
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
                      if (!window.confirm(`Delete ${ids.length} blocker${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
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
        emptyIcon={ShieldOff}
        emptyTitle="No blockers yet"
        emptyDescription="Log the first blocker to start tracking."
      />

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
      {/* Detail drawer — issue-style: inline-editable fields + Comments + Activity.
          Replaces the old edit dialog as the primary row-detail view. */}
      {openBlocker && (
        <PmEntityDrawer
          key={openBlocker.id}
          orgId={orgId}
          projectId={projectId}
          subjectType="blocker"
          subjectId={openBlocker.id}
          title={openBlocker.title}
          code={openBlocker.code}
          patchPath={`${apiBase}/${openBlocker.id}`}
          fields={blockerFields(openBlocker)}
          open={openBlockerId !== null}
          onOpenChange={(o) => !o && setOpenBlockerId(null)}
          onSaved={() => void refetch()}
        />
      )}
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
    </>
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

          <FormField label="Related reference">
            {(p) => (
              <Input
                {...p}
                value={form.relatedRef}
                onChange={(e) => setForm((f) => ({ ...f, relatedRef: e.target.value }))}
                placeholder="e.g. ticket, contract section, or risk ID"
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
