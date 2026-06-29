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
import { Loader2, Plus, Trash2, AlertTriangle, Handshake } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";

interface PartnerLite {
  id: string;
  name: string;
}

interface PartnerDetail {
  id: string;
  name: string;
  type: string;
  status: string;
  socioEconomic: string | null;
  cageCode: string | null;
  perfRating: number | null;
}

interface Vendor {
  id: string;
  partnerId: string | null;
  partner: PartnerDetail | null;
  title: string;
  value: number | null;
  currency: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
}

interface VendorTrackerProps {
  orgId: string;
  projectId: string;
  partners: PartnerLite[];
}

type SortKey = "value" | "name" | "status";

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "signed", label: "Signed" },
  { value: "completed", label: "Completed" },
  { value: "terminated", label: "Terminated" },
];

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  signed: "Signed",
  completed: "Completed",
  terminated: "Terminated",
};

interface VendorForm {
  partnerId: string;
  title: string;
  value: string;
  currency: string;
  status: string;
  startDate: string;
  endDate: string;
}

const emptyForm: VendorForm = {
  partnerId: "",
  title: "",
  value: "",
  currency: "USD",
  status: "active",
  startDate: "",
  endDate: "",
};

function toDateInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

function vendorToForm(v: Vendor): VendorForm {
  return {
    partnerId: v.partnerId ?? "",
    title: v.title,
    value: v.value != null ? String(v.value) : "",
    currency: v.currency,
    status: v.status,
    startDate: toDateInput(v.startDate),
    endDate: toDateInput(v.endDate),
  };
}

function formToBody(f: VendorForm) {
  return {
    partnerId: f.partnerId,
    title: f.title.trim(),
    value: f.value !== "" ? Number(f.value) : null,
    currency: f.currency || "USD",
    status: f.status,
    startDate: f.startDate ? new Date(f.startDate).toISOString() : null,
    endDate: f.endDate ? new Date(f.endDate).toISOString() : null,
  };
}

function formatMoney(value: number | null, currency: string): string {
  if (value == null) return "—";
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  });
}

function formatPoP(startDate: string | null, endDate: string | null): string {
  if (!startDate && !endDate) return "—";
  const fmt = (iso: string) => new Date(iso).toISOString().slice(0, 10);
  if (startDate && endDate) return `${fmt(startDate)} – ${fmt(endDate)}`;
  if (startDate) return `${fmt(startDate)} –`;
  return `– ${fmt(endDate!)}`;
}

export function VendorTracker({ orgId, projectId, partners }: VendorTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/vendors`;
  const queryKey = useOrgQueryKey("vendors", projectId);
  const { data: vendors = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<Vendor[]>(apiBase),
  });
  const canEdit = usePermissions().can(Permission.PROJECT_UPDATE);

  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("value");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [deleting, setDeleting] = useState<Vendor | null>(null);
  const [form, setForm] = useState<VendorForm>(emptyForm);

  const createMutation = useOrgMutation<Vendor, Error, VendorForm>({
    mutationFn: (f) =>
      jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["vendors", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the vendor contract."),
  });

  const updateMutation = useOrgMutation<Vendor, Error, { id: string; f: VendorForm }>({
    mutationFn: ({ id, f }) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["vendors", projectId]],
    onSuccess: () => setEditing(null),
    onError: (e) => notifyError(e, "Couldn't update the vendor contract."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["vendors", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the vendor contract."),
  });

  const view = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const rows = f
      ? vendors.filter(
          (v) =>
            v.title.toLowerCase().includes(f) ||
            (v.partner?.name ?? "").toLowerCase().includes(f) ||
            (v.partner?.socioEconomic ?? "").toLowerCase().includes(f),
        )
      : vendors.slice();
    rows.sort((a, b) => {
      if (sort === "value") return (b.value ?? -Infinity) - (a.value ?? -Infinity);
      if (sort === "name")
        return (a.partner?.name ?? "").localeCompare(b.partner?.name ?? "");
      return a.status.localeCompare(b.status);
    });
    return rows;
  }, [vendors, filter, sort]);

  function openCreate() {
    setForm({ ...emptyForm, partnerId: partners[0]?.id ?? "" });
    setCreateOpen(true);
  }
  function openEdit(v: Vendor) {
    setForm(vendorToForm(v));
    setEditing(v);
  }

  const totalCommitted = vendors.reduce((sum, v) => sum + (v.value ?? 0), 0);

  if (isLoading) return <TableSkeleton />;
  if (isError)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <LoadError title="Couldn't load vendor contracts" onRetry={() => void refetch()} />
      </div>
    );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">Vendor Register</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {vendors.length} contract{vendors.length === 1 ? "" : "s"} ·{" "}
            {totalCommitted.toLocaleString(undefined, {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 0,
            })}{" "}
            total committed
          </p>
        </div>
        {canEdit && (
          <Button onClick={openCreate}>
            <Plus className="size-4" /> New Vendor Contract
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by vendor, title, socio-econ…"
          className="max-w-xs"
        />
        <Select value={sort} onValueChange={(v) => setSort((v ?? "value") as SortKey)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="value">Sort: Committed (high→low)</SelectItem>
            <SelectItem value="name">Sort: Vendor name</SelectItem>
            <SelectItem value="status">Sort: Status</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {view.length === 0 ? (
        <EmptyState
          icon={Handshake}
          title={filter ? "No matching vendor contracts" : "No vendor contracts yet"}
          description={
            filter
              ? "Try a different filter."
              : "Add the first subcontract to start the vendor register."
          }
          action={
            !filter && canEdit ? (
              <Button onClick={openCreate}>
                <Plus className="size-4" /> New Vendor Contract
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-3 py-2 font-medium">Vendor</th>
                <th className="px-3 py-2 font-medium">Socio-econ</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 text-right font-medium">Committed</th>
                <th className="px-3 py-2 font-medium">PoP</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {view.map((v) => (
                <tr
                  key={v.id}
                  className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)]${canEdit ? " cursor-pointer" : ""}`}
                  onClick={canEdit ? () => openEdit(v) : undefined}
                >
                  <td className="px-3 py-2 font-medium text-[var(--text)]">
                    {v.partner?.name ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--text-muted)]">
                    {v.partner?.socioEconomic ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--text-muted)]">
                    {v.partner?.type ?? "—"}
                  </td>
                  <td className="max-w-xs truncate px-3 py-2 text-[var(--text)]">{v.title}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text)]">
                    {formatMoney(v.value, v.currency)}
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--text-muted)]">
                    {formatPoP(v.startDate, v.endDate)}
                  </td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">
                    {STATUS_LABEL[v.status] ?? v.status}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete vendor contract"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(v);
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
      <VendorDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New Vendor Contract"
        form={form}
        setForm={setForm}
        partners={partners}
        pending={createMutation.isPending}
        onSubmit={() => createMutation.mutate(form)}
        submitLabel="Create"
      />

      {/* Edit */}
      <VendorDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title="Edit Vendor Contract"
        form={form}
        setForm={setForm}
        partners={partners}
        pending={updateMutation.isPending}
        onSubmit={() => editing && updateMutation.mutate({ id: editing.id, f: form })}
        submitLabel="Save"
      />

      {/* Delete confirm */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" /> Delete vendor contract
            </DialogTitle>
            <DialogDescription>
              Permanently delete{" "}
              <span className="font-medium">{deleting?.partner?.name ?? "this contract"}</span> —{" "}
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
              {deleteMutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function VendorDialog({
  open,
  onOpenChange,
  title,
  form,
  setForm,
  partners,
  pending,
  onSubmit,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  form: VendorForm;
  setForm: React.Dispatch<React.SetStateAction<VendorForm>>;
  partners: PartnerLite[];
  pending: boolean;
  onSubmit: () => void;
  submitLabel: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Enter the subcontract details. Vendor must be an org partner.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          {/* Vendor picker */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">
              Vendor <span className="text-destructive">*</span>
            </label>
            <Select
              value={form.partnerId}
              onValueChange={(v) => setForm((f) => ({ ...f, partnerId: v ?? "" }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a vendor partner" />
              </SelectTrigger>
              <SelectContent>
                {partners.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Title */}
          <FormField label="Contract title" required>
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

          {/* Value + Currency */}
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Committed value ($)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  step="any"
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                  placeholder="0"
                />
              )}
            </FormField>
            <FormField label="Currency">
              {(p) => (
                <Input
                  {...p}
                  value={form.currency}
                  onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                  placeholder="USD"
                />
              )}
            </FormField>
          </div>

          {/* Status */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Status</label>
            <Select
              value={form.status}
              onValueChange={(v) => setForm((f) => ({ ...f, status: v ?? "active" }))}
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

          {/* PoP */}
          <div className="grid grid-cols-2 gap-4">
            <FormField label="PoP start">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="PoP end">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                />
              )}
            </FormField>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={pending || !form.title.trim() || !form.partnerId}
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
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-8 w-40" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
