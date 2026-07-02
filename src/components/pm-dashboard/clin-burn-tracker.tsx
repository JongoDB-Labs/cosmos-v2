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
import { Loader2, Trash2, DollarSign, AlertTriangle, Eye, CircleDot } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { PmEntityDrawer, type PmField } from "@/components/pm-dashboard/pm-entity-drawer";
import { PmDataTable } from "@/components/pm-dashboard/pm-data-table";
import { bulkFanOut } from "@/lib/pm/bulk";
import type { ActionMenuGroup } from "@/components/ui/action-menu";

type ClinStatus = "active" | "on_hold" | "closed";

interface ClinBurn {
  id: string;
  code: string;
  title: string;
  value: number;
  fundedValue: number;
  popStart: string | null;
  popEnd: string | null;
  status: ClinStatus;
  laborCost: number;
  expenseCost: number;
  burned: number;
  remaining: number;
  percentConsumed: number | null;
}

interface ClinBurnTrackerProps {
  orgId: string;
  projectId: string;
}

const STATUS_OPTIONS: { value: ClinStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On Hold" },
  { value: "closed", label: "Closed" },
];

const STATUS_LABEL: Record<ClinStatus, string> = {
  active: "Active",
  on_hold: "On Hold",
  closed: "Closed",
};

const USD = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

function BurnBar({ percentConsumed }: { percentConsumed: number | null }) {
  if (percentConsumed === null) {
    return <span className="text-[var(--text-muted)]">—</span>;
  }
  const pct = percentConsumed;
  const barColor =
    pct > 100
      ? "var(--status-blocked,#dc2626)"
      : pct >= 80
        ? "var(--status-warn,#d97706)"
        : "#16a34a";
  const width = `${Math.min(100, pct)}%`;
  return (
    <div className="flex items-center gap-2">
      <div
        className="relative h-2 w-20 overflow-hidden rounded-full"
        style={{ backgroundColor: "var(--border)" }}
      >
        <div
          style={{ width, backgroundColor: barColor }}
          className="absolute inset-y-0 left-0 rounded-full transition-all"
        />
      </div>
      <span className="tabular-nums text-xs" style={{ color: barColor }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

// Sortable columns (headers sort on click via the shared DataTable). Pure — no
// component state, so defined at module scope. The money + burn columns are
// computed server-side; each gets an accessorFn returning the numeric value plus
// an explicit numeric sortingFn so the header sorts by magnitude, not string.
const CLIN_COLUMNS: ColumnDef<ClinBurn>[] = [
  {
    accessorKey: "code",
    header: "CLIN",
    cell: ({ row }) => <span className="font-mono text-xs text-[var(--text-muted)]">{row.original.code}</span>,
  },
  {
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => <span className="block max-w-xs truncate text-[var(--text)]">{row.original.title}</span>,
  },
  {
    id: "fundedValue",
    header: "Funded ($)",
    accessorFn: (c) => c.fundedValue,
    sortingFn: (a, b) => a.original.fundedValue - b.original.fundedValue,
    cell: ({ row }) => (
      <span className="block text-right tabular-nums text-[var(--text)]">{USD(row.original.fundedValue)}</span>
    ),
  },
  {
    id: "value",
    header: "Ceiling ($)",
    accessorFn: (c) => c.value,
    sortingFn: (a, b) => a.original.value - b.original.value,
    cell: ({ row }) => (
      <span className="block text-right tabular-nums text-[var(--text)]">{USD(row.original.value)}</span>
    ),
  },
  {
    id: "burned",
    header: "Burned ($)",
    accessorFn: (c) => c.burned,
    sortingFn: (a, b) => a.original.burned - b.original.burned,
    cell: ({ row }) => (
      <span className="block text-right tabular-nums text-[var(--text)]">{USD(row.original.burned)}</span>
    ),
  },
  {
    id: "remaining",
    header: "Remaining ($)",
    accessorFn: (c) => c.remaining,
    sortingFn: (a, b) => a.original.remaining - b.original.remaining,
    cell: ({ row }) => (
      <span className="block text-right tabular-nums text-[var(--text)]">{USD(row.original.remaining)}</span>
    ),
  },
  {
    id: "percentConsumed",
    header: "% Consumed",
    // Null (no burn baseline yet) sorts to the bottom via -1.
    accessorFn: (c) => c.percentConsumed ?? -1,
    sortingFn: (a, b) => (a.original.percentConsumed ?? -1) - (b.original.percentConsumed ?? -1),
    cell: ({ row }) => <BurnBar percentConsumed={row.original.percentConsumed} />,
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => STATUS_LABEL[row.original.status],
  },
];

interface ClinForm {
  code: string;
  title: string;
  value: string;
  fundedValue: string;
  status: ClinStatus;
  popStart: string;
  popEnd: string;
}

const emptyForm: ClinForm = {
  code: "",
  title: "",
  value: "",
  fundedValue: "",
  status: "active",
  popStart: "",
  popEnd: "",
};

function formToBody(f: ClinForm) {
  return {
    code: f.code.trim(),
    title: f.title.trim(),
    value: f.value !== "" ? Number(f.value) : 0,
    fundedValue: f.fundedValue !== "" ? Number(f.fundedValue) : 0,
    status: f.status,
    popStart: f.popStart ? new Date(f.popStart).toISOString() : null,
    popEnd: f.popEnd ? new Date(f.popEnd).toISOString() : null,
  };
}

export function ClinBurnTracker({ orgId, projectId }: ClinBurnTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/clins`;
  const queryKey = useOrgQueryKey("clins", projectId);
  const {
    data: clins = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<ClinBurn[]>(apiBase),
  });
  const canEdit = usePermissions().can(Permission.PROJECT_UPDATE);

  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<ClinBurn | null>(null);
  const [form, setForm] = useState<ClinForm>(emptyForm);
  // The drawer is the primary row-detail view. We hold the open CLIN's id so the
  // drawer's fields rebuild from the freshest cached row after an inline PATCH.
  const [openClinId, setOpenClinId] = useState<string | null>(null);
  const openClin = openClinId ? clins.find((c) => c.id === openClinId) ?? null : null;

  const createMutation = useOrgMutation<ClinBurn, Error, ClinForm>({
    mutationFn: (f) =>
      jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["clins", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the CLIN."),
  });
  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["clins", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the CLIN."),
  });

  const patch = useCallback(
    (id: string, body: Record<string, unknown>) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    [apiBase],
  );

  // Right-click / ⋯ row menu: view+edit, quick status, delete.
  const rowActions = useCallback(
    (c: ClinBurn): ActionMenuGroup[] => {
      const groups: ActionMenuGroup[] = [
        { items: [{ label: "View / edit", icon: Eye, onClick: () => setOpenClinId(c.id) }] },
      ];
      if (canEdit) {
        groups.push({
          label: "Set status",
          items: STATUS_OPTIONS.map((st) => ({
            label: st.label,
            icon: CircleDot,
            onClick: async () => {
              try {
                await patch(c.id, { status: st.value });
                void refetch();
              } catch (e) {
                notifyError(e, "Couldn't update status.");
              }
            },
          })),
        });
        groups.push({ items: [{ label: "Delete", icon: Trash2, variant: "destructive", onClick: () => setDeleting(c) }] });
      }
      return groups;
    },
    [canEdit, patch, refetch],
  );

  function openCreate() {
    setForm(emptyForm);
    setCreateOpen(true);
  }
  // Row click → open the detail drawer (the primary row-detail view).
  function openDetail(c: ClinBurn) {
    setOpenClinId(c.id);
  }

  // Build the drawer's inline-editable field list for the open CLIN. Code,
  // title, status, value, etc. are editable and PATCH the clins endpoint by
  // key; burned / remaining / % consumed are computed server-side, read-only.
  function clinFields(c: ClinBurn): PmField[] {
    return [
      { key: "code", label: "CLIN code", type: "text", value: c.code, editable: canEdit },
      { key: "title", label: "Title", type: "text", value: c.title, editable: canEdit },
      {
        key: "status",
        label: "Status",
        type: "select",
        value: c.status,
        editable: canEdit,
        options: STATUS_OPTIONS,
      },
      {
        key: "value",
        label: "Ceiling value ($)",
        type: "number",
        value: c.value,
        editable: canEdit,
        min: 0,
      },
      {
        key: "fundedValue",
        label: "Funded value ($)",
        type: "number",
        value: c.fundedValue,
        editable: canEdit,
        min: 0,
      },
      { key: "popStart", label: "PoP start", type: "date", value: c.popStart, editable: canEdit },
      { key: "popEnd", label: "PoP end", type: "date", value: c.popEnd, editable: canEdit },
      { key: "burned", label: "Burned ($)", type: "number", value: c.burned, editable: false },
      {
        key: "remaining",
        label: "Remaining ($)",
        type: "number",
        value: c.remaining,
        editable: false,
      },
      {
        key: "percentConsumed",
        label: "% consumed",
        type: "number",
        value: c.percentConsumed,
        editable: false,
      },
    ];
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load CLINs" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <>
      <PmDataTable
        title="CLIN Burn"
        subtitle={`${clins.length} CLIN${clins.length === 1 ? "" : "s"}`}
        rows={clins}
        columns={CLIN_COLUMNS}
        search={filter}
        onSearchChange={setFilter}
        searchText={(c) => [c.code, c.title].join(" ")}
        searchPlaceholder="Filter by CLIN code or title…"
        onRowClick={openDetail}
        rowActions={rowActions}
        onNew={canEdit ? openCreate : undefined}
        newLabel="New CLIN"
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
                        <SelectItem key={st.value} value={st.value}>{st.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={async () => {
                      if (!window.confirm(`Delete ${ids.length} CLIN${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
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
        emptyIcon={DollarSign}
        emptyTitle="No CLINs yet"
        emptyDescription="Add the first CLIN to start tracking burn."
      />

      {/* Create */}
      <ClinDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New CLIN"
        form={form}
        setForm={setForm}
        pending={createMutation.isPending}
        onSubmit={() => createMutation.mutate(form)}
        submitLabel="Create"
      />

      {/* Detail drawer — issue-style: inline-editable fields + Comments + Activity.
          Replaces the old edit dialog as the primary row-detail view. Burned /
          remaining / % consumed are computed server-side and shown read-only. */}
      {openClin && (
        <PmEntityDrawer
          key={openClin.id}
          orgId={orgId}
          projectId={projectId}
          subjectType="clin"
          subjectId={openClin.id}
          title={openClin.title}
          code={openClin.code}
          patchPath={`${apiBase}/${openClin.id}`}
          fields={clinFields(openClin)}
          open={openClinId !== null}
          onOpenChange={(o) => !o && setOpenClinId(null)}
          onSaved={() => void refetch()}
        />
      )}

      {/* Delete confirm */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" /> Delete CLIN
            </DialogTitle>
            <DialogDescription>
              Permanently delete <span className="font-medium">{deleting?.code}</span> —{" "}
              {deleting?.title}. This cannot be undone.
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

function ClinDialog({
  open,
  onOpenChange,
  title,
  form,
  setForm,
  pending,
  onSubmit,
  submitLabel,
  readOnlyBurn,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  form: ClinForm;
  setForm: React.Dispatch<React.SetStateAction<ClinForm>>;
  pending: boolean;
  onSubmit: () => void;
  submitLabel: string;
  readOnlyBurn?: ClinBurn;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Burned, remaining, and % consumed are computed server-side and shown read-only.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="CLIN code" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                  placeholder="e.g. 0001AA"
                  autoFocus
                />
              )}
            </FormField>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Status</label>
              <Select
                value={form.status}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, status: (v ?? "active") as ClinStatus }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <FormField label="Title" required>
            {(p) => (
              <Input
                {...p}
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Short descriptive title"
              />
            )}
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Ceiling value ($)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  step={1}
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                  placeholder="0"
                />
              )}
            </FormField>
            <FormField label="Funded value ($)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  step={1}
                  value={form.fundedValue}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, fundedValue: e.target.value }))
                  }
                  placeholder="0"
                />
              )}
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="PoP start">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.popStart}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, popStart: e.target.value }))
                  }
                />
              )}
            </FormField>
            <FormField label="PoP end">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.popEnd}
                  onChange={(e) => setForm((f) => ({ ...f, popEnd: e.target.value }))}
                />
              )}
            </FormField>
          </div>

          {readOnlyBurn && (
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Computed burn (read-only)
              </p>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-xs text-[var(--text-muted)]">Burned</p>
                  <p className="tabular-nums font-medium text-[var(--text)]">
                    {USD(readOnlyBurn.burned)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[var(--text-muted)]">Remaining</p>
                  <p className="tabular-nums font-medium text-[var(--text)]">
                    {USD(readOnlyBurn.remaining)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[var(--text-muted)]">% Consumed</p>
                  <div className="mt-0.5">
                    <BurnBar percentConsumed={readOnlyBurn.percentConsumed} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={pending || !form.code.trim() || !form.title.trim()}
          >
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
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
