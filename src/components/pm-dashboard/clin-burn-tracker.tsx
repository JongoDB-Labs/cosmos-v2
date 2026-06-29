"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Loader2, Plus, Trash2, DollarSign, AlertTriangle } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";

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

function toDateInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

function clinToForm(c: ClinBurn): ClinForm {
  return {
    code: c.code,
    title: c.title,
    value: c.value === 0 ? "" : String(c.value),
    fundedValue: c.fundedValue === 0 ? "" : String(c.fundedValue),
    status: c.status,
    popStart: toDateInput(c.popStart),
    popEnd: toDateInput(c.popEnd),
  };
}

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

const USD = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

type SortKey = "code" | "percentConsumed" | "burned";

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
  const [sort, setSort] = useState<SortKey>("code");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ClinBurn | null>(null);
  const [deleting, setDeleting] = useState<ClinBurn | null>(null);
  const [form, setForm] = useState<ClinForm>(emptyForm);

  const createMutation = useOrgMutation<ClinBurn, Error, ClinForm>({
    mutationFn: (f) =>
      jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["clins", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the CLIN."),
  });
  const updateMutation = useOrgMutation<ClinBurn, Error, { id: string; f: ClinForm }>({
    mutationFn: ({ id, f }) =>
      jsonFetch(`${apiBase}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(formToBody(f)),
      }),
    invalidate: [["clins", projectId]],
    onSuccess: () => setEditing(null),
    onError: (e) => notifyError(e, "Couldn't update the CLIN."),
  });
  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["clins", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the CLIN."),
  });

  const view = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const rows = f
      ? clins.filter(
          (c) =>
            c.code.toLowerCase().includes(f) || c.title.toLowerCase().includes(f),
        )
      : clins.slice();
    rows.sort((a, b) => {
      if (sort === "code") return a.code.localeCompare(b.code);
      if (sort === "percentConsumed") {
        const ap = a.percentConsumed ?? -1;
        const bp = b.percentConsumed ?? -1;
        return bp - ap;
      }
      return b.burned - a.burned;
    });
    return rows;
  }, [clins, filter, sort]);

  function openCreate() {
    setForm(emptyForm);
    setCreateOpen(true);
  }
  function openEdit(c: ClinBurn) {
    setForm(clinToForm(c));
    setEditing(c);
  }

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load CLINs" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">CLIN Burn</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {clins.length} CLIN{clins.length === 1 ? "" : "s"}
          </p>
        </div>
        {canEdit && (
          <Button onClick={openCreate}>
            <Plus className="size-4" /> New CLIN
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by CLIN code or title…"
          className="max-w-xs"
        />
        <Select value={sort} onValueChange={(v) => setSort((v ?? "code") as SortKey)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="code">Sort: CLIN Code</SelectItem>
            <SelectItem value="percentConsumed">Sort: % Consumed</SelectItem>
            <SelectItem value="burned">Sort: Burned ($)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {view.length === 0 ? (
        <EmptyState
          icon={DollarSign}
          title={filter ? "No matching CLINs" : "No CLINs yet"}
          description={
            filter
              ? "Try a different filter."
              : "Add the first CLIN to start tracking burn."
          }
          action={
            !filter && canEdit ? (
              <Button onClick={openCreate}>
                <Plus className="size-4" /> New CLIN
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-3 py-2 font-medium">CLIN</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 text-right font-medium">Funded ($)</th>
                <th className="px-3 py-2 text-right font-medium">Ceiling ($)</th>
                <th className="px-3 py-2 text-right font-medium">Burned ($)</th>
                <th className="px-3 py-2 text-right font-medium">Remaining ($)</th>
                <th className="px-3 py-2 font-medium">% Consumed</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {view.map((c) => (
                <tr
                  key={c.id}
                  className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)]${canEdit ? " cursor-pointer" : ""}`}
                  onClick={canEdit ? () => openEdit(c) : undefined}
                >
                  <td className="px-3 py-2 font-mono text-xs text-[var(--text-muted)]">
                    {c.code}
                  </td>
                  <td className="max-w-xs truncate px-3 py-2 text-[var(--text)]">
                    {c.title}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text)]">
                    {USD(c.fundedValue)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text)]">
                    {USD(c.value)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text)]">
                    {USD(c.burned)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text)]">
                    {USD(c.remaining)}
                  </td>
                  <td className="px-3 py-2">
                    <BurnBar percentConsumed={c.percentConsumed} />
                  </td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">
                    {STATUS_LABEL[c.status]}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete CLIN"
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

      {/* Edit */}
      <ClinDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing ? `Edit ${editing.code}` : "Edit CLIN"}
        form={form}
        setForm={setForm}
        pending={updateMutation.isPending}
        onSubmit={() => editing && updateMutation.mutate({ id: editing.id, f: form })}
        submitLabel="Save"
        readOnlyBurn={editing ?? undefined}
      />

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
    </div>
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
