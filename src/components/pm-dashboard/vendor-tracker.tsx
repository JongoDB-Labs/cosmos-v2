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
import { Loader2, Trash2, AlertTriangle, Handshake, Eye, CircleDot } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { PmEntityDrawer, type PmField } from "@/components/pm-dashboard/pm-entity-drawer";
import { PmDataTable } from "@/components/pm-dashboard/pm-data-table";
import { bulkFanOut } from "@/lib/pm/bulk";
import type { ActionMenuGroup } from "@/components/ui/action-menu";

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
  ndaOnFile: boolean;
  ndaExpiry: string | null;
  pocName: string | null;
  pocEmail: string | null;
}

interface Vendor {
  id: string;
  partnerId: string | null;
  partner: PartnerDetail | null;
  title: string;
  value: number | null; // contract ceiling
  fundedValue: number | null;
  invoicedValue: number | null;
  remainingFunded: number | null;
  pctBurnedFunded: number | null;
  paymentTerms: string | null;
  agmtType: string | null;
  agmtNumber: string | null;
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

// Lifecycle order for the sortable Status column.
const STATUS_RANK: Record<string, number> = {
  draft: 0,
  active: 1,
  signed: 2,
  completed: 3,
  terminated: 4,
};

interface VendorForm {
  partnerId: string;
  title: string;
  value: string;
  fundedValue: string;
  invoicedValue: string;
  paymentTerms: string;
  agmtType: string;
  agmtNumber: string;
  currency: string;
  status: string;
  startDate: string;
  endDate: string;
  ndaOnFile: boolean;
  ndaExpiry: string;
  pocName: string;
  pocEmail: string;
}

const emptyForm: VendorForm = {
  partnerId: "",
  title: "",
  value: "",
  fundedValue: "",
  invoicedValue: "",
  paymentTerms: "",
  agmtType: "",
  agmtNumber: "",
  currency: "USD",
  status: "active",
  startDate: "",
  endDate: "",
  ndaOnFile: false,
  ndaExpiry: "",
  pocName: "",
  pocEmail: "",
};

function formToBody(f: VendorForm) {
  return {
    partnerId: f.partnerId,
    title: f.title.trim(),
    value: f.value !== "" ? Number(f.value) : null,
    fundedValue: f.fundedValue !== "" ? Number(f.fundedValue) : null,
    invoicedValue: f.invoicedValue !== "" ? Number(f.invoicedValue) : null,
    paymentTerms: f.paymentTerms.trim() || null,
    agmtType: f.agmtType.trim() || null,
    agmtNumber: f.agmtNumber.trim() || null,
    currency: f.currency || "USD",
    status: f.status,
    startDate: f.startDate ? new Date(f.startDate).toISOString() : null,
    endDate: f.endDate ? new Date(f.endDate).toISOString() : null,
    ndaOnFile: f.ndaOnFile,
    ndaExpiry: f.ndaExpiry ? new Date(f.ndaExpiry).toISOString() : null,
    pocName: f.pocName.trim() || null,
    pocEmail: f.pocEmail.trim() || null,
  };
}

/** Burn color thresholds: over-funded → red, hot → amber, else green. */
function burnTone(pct: number | null): string {
  if (pct == null) return "var(--text-muted)";
  if (pct > 100) return "var(--danger, #dc2626)";
  if (pct >= 85) return "var(--warning, #d97706)";
  return "var(--success, #16a34a)";
}

function formatMoney(value: number | null, currency: string): string {
  if (value == null) return "—";
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  });
}

/** Sort numeric columns with nulls last (treated as the lowest value). */
function numSort(a: number | null, b: number | null): number {
  return (a ?? -Infinity) - (b ?? -Infinity);
}

// Sortable columns (headers sort on click via the shared DataTable). Pure — no
// component state, so defined at module scope. Value/burn/status columns get an
// explicit sortingFn so they order by number/lifecycle, not lexicographically.
const VENDOR_COLUMNS: ColumnDef<Vendor>[] = [
  {
    id: "vendor",
    header: "Vendor",
    accessorFn: (v) => v.partner?.name ?? "",
    cell: ({ row }) => {
      const v = row.original;
      return (
        <div>
          <span className="font-medium text-[var(--text)]">{v.partner?.name ?? "—"}</span>
          {v.title ? (
            <span className="block text-xs font-normal text-[var(--text-muted)]">{v.title}</span>
          ) : null}
        </div>
      );
    },
  },
  {
    id: "socioEconomic",
    header: "Socio-econ",
    accessorFn: (v) => v.partner?.socioEconomic ?? "",
    cell: ({ row }) => (
      <span className="text-xs text-[var(--text-muted)]">{row.original.partner?.socioEconomic ?? "—"}</span>
    ),
  },
  {
    id: "value",
    header: "Ceiling",
    accessorFn: (v) => v.value ?? 0,
    sortingFn: (a, b) => numSort(a.original.value, b.original.value),
    cell: ({ row }) => (
      <span className="tabular-nums text-[var(--text)]">
        {formatMoney(row.original.value, row.original.currency)}
      </span>
    ),
  },
  {
    id: "fundedValue",
    header: "Funded",
    accessorFn: (v) => v.fundedValue ?? 0,
    sortingFn: (a, b) => numSort(a.original.fundedValue, b.original.fundedValue),
    cell: ({ row }) => (
      <span className="tabular-nums text-[var(--text)]">
        {formatMoney(row.original.fundedValue, row.original.currency)}
      </span>
    ),
  },
  {
    id: "invoicedValue",
    header: "Invoiced",
    accessorFn: (v) => v.invoicedValue ?? 0,
    sortingFn: (a, b) => numSort(a.original.invoicedValue, b.original.invoicedValue),
    cell: ({ row }) => (
      <span className="tabular-nums text-[var(--text)]">
        {formatMoney(row.original.invoicedValue, row.original.currency)}
      </span>
    ),
  },
  {
    id: "pctBurnedFunded",
    header: "% Burned",
    accessorFn: (v) => v.pctBurnedFunded ?? 0,
    sortingFn: (a, b) => numSort(a.original.pctBurnedFunded, b.original.pctBurnedFunded),
    cell: ({ row }) => {
      const pct = row.original.pctBurnedFunded;
      if (pct == null) return <span className="text-xs text-[var(--text-muted)]">—</span>;
      return (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--border)]">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(pct, 100)}%`, background: burnTone(pct) }}
            />
          </div>
          <span className="tabular-nums text-xs" style={{ color: burnTone(pct) }}>
            {pct}%
          </span>
        </div>
      );
    },
  },
  {
    id: "nda",
    header: "NDA",
    accessorFn: (v) => (v.partner?.ndaOnFile ? 1 : 0),
    cell: ({ row }) =>
      row.original.partner?.ndaOnFile ? (
        <span className="text-xs" style={{ color: "var(--success, #16a34a)" }}>On file</span>
      ) : (
        <span className="text-xs text-[var(--text-muted)]">—</span>
      ),
  },
  {
    id: "status",
    header: "Status",
    accessorFn: (v) => v.status,
    sortingFn: (a, b) =>
      (STATUS_RANK[a.original.status] ?? 99) - (STATUS_RANK[b.original.status] ?? 99),
    cell: ({ row }) => (
      <span className="text-[var(--text-muted)]">
        {STATUS_LABEL[row.original.status] ?? row.original.status}
      </span>
    ),
  },
];

export function VendorTracker({ orgId, projectId, partners }: VendorTrackerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}/vendors`;
  const queryKey = useOrgQueryKey("vendors", projectId);
  const { data: vendors = [], isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<Vendor[]>(apiBase),
  });
  const canEdit = usePermissions().can(Permission.PROJECT_UPDATE);

  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<Vendor | null>(null);
  const [form, setForm] = useState<VendorForm>(emptyForm);
  // The drawer is the primary row-detail view. We hold the open vendor's id so
  // the drawer's fields rebuild from the freshest cached row after an inline PATCH.
  const [openVendorId, setOpenVendorId] = useState<string | null>(null);
  const openVendor = openVendorId ? vendors.find((v) => v.id === openVendorId) ?? null : null;

  const createMutation = useOrgMutation<Vendor, Error, VendorForm>({
    mutationFn: (f) =>
      jsonFetch(apiBase, { method: "POST", body: JSON.stringify(formToBody(f)) }),
    invalidate: [["vendors", projectId]],
    onSuccess: () => setCreateOpen(false),
    onError: (e) => notifyError(e, "Couldn't create the vendor contract."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["vendors", projectId]],
    onSuccess: () => setDeleting(null),
    onError: (e) => notifyError(e, "Couldn't delete the vendor contract."),
  });

  const patch = useCallback(
    (id: string, body: Record<string, unknown>) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    [apiBase],
  );

  // Right-click / ⋯ row menu: view+edit, quick status change, delete.
  const rowActions = useCallback(
    (v: Vendor): ActionMenuGroup[] => {
      const groups: ActionMenuGroup[] = [
        { items: [{ label: "View / edit", icon: Eye, onClick: () => setOpenVendorId(v.id) }] },
      ];
      if (canEdit) {
        groups.push({
          label: "Set status",
          items: STATUS_OPTIONS.map((st) => ({
            label: st.label,
            icon: CircleDot,
            onClick: async () => {
              try {
                await patch(v.id, { status: st.value });
                void refetch();
              } catch (e) {
                notifyError(e, "Couldn't update status.");
              }
            },
          })),
        });
        groups.push({ items: [{ label: "Delete", icon: Trash2, variant: "destructive", onClick: () => setDeleting(v) }] });
      }
      return groups;
    },
    [canEdit, patch, refetch],
  );

  function openCreate() {
    setForm({ ...emptyForm, partnerId: partners[0]?.id ?? "" });
    setCreateOpen(true);
  }
  // Row click → open the detail drawer (the primary row-detail view).
  function openDetail(v: Vendor) {
    setOpenVendorId(v.id);
  }

  // Build the drawer's inline-editable field list for the open vendor. Contract
  // fields (title, status, value…) and partner-level NDA/POC fields all PATCH the
  // vendors endpoint by key; the burn signal (% burned, remaining) is derived
  // server-side and shown read-only.
  function vendorFields(v: Vendor): PmField[] {
    return [
      { key: "title", label: "Contract title", type: "text", value: v.title, editable: canEdit },
      {
        key: "partnerId",
        label: "Vendor",
        type: "select",
        value: v.partnerId,
        editable: canEdit && partners.length > 0,
        options: partners.map((p) => ({ value: p.id, label: p.name })),
        placeholder: "Select vendor",
      },
      {
        key: "status",
        label: "Status",
        type: "select",
        value: v.status,
        editable: canEdit,
        options: STATUS_OPTIONS,
      },
      { key: "value", label: "Committed value ($)", type: "number", value: v.value, editable: canEdit },
      {
        key: "fundedValue",
        label: "Funded to date ($)",
        type: "number",
        value: v.fundedValue,
        editable: canEdit,
      },
      {
        key: "invoicedValue",
        label: "Invoiced to date ($)",
        type: "number",
        value: v.invoicedValue,
        editable: canEdit,
      },
      { key: "currency", label: "Currency", type: "text", value: v.currency, editable: canEdit },
      { key: "agmtType", label: "Agmt type", type: "text", value: v.agmtType, editable: canEdit },
      { key: "agmtNumber", label: "Agmt number", type: "text", value: v.agmtNumber, editable: canEdit },
      {
        key: "paymentTerms",
        label: "Payment terms",
        type: "text",
        value: v.paymentTerms,
        editable: canEdit,
      },
      { key: "startDate", label: "PoP start", type: "date", value: v.startDate, editable: canEdit },
      { key: "endDate", label: "PoP end", type: "date", value: v.endDate, editable: canEdit },
      {
        key: "ndaOnFile",
        label: "NDA on file",
        type: "select",
        value: v.partner?.ndaOnFile ? "true" : "false",
        editable: canEdit,
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
        coerce: (val) => val === "true",
      },
      {
        key: "ndaExpiry",
        label: "NDA expiry",
        type: "date",
        value: v.partner?.ndaExpiry ?? null,
        editable: canEdit,
      },
      {
        key: "pocName",
        label: "POC name",
        type: "text",
        value: v.partner?.pocName ?? null,
        editable: canEdit,
      },
      {
        key: "pocEmail",
        label: "POC email",
        type: "text",
        value: v.partner?.pocEmail ?? null,
        editable: canEdit,
      },
      {
        key: "pctBurnedFunded",
        label: "% burned (funded)",
        type: "number",
        value: v.pctBurnedFunded,
        editable: false,
      },
      {
        key: "remainingFunded",
        label: "Remaining funded ($)",
        type: "number",
        value: v.remainingFunded,
        editable: false,
      },
    ];
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
    <>
      <PmDataTable
        title="Vendor Register"
        subtitle={`${vendors.length} contract${vendors.length === 1 ? "" : "s"} · ${totalCommitted.toLocaleString(
          undefined,
          { style: "currency", currency: "USD", maximumFractionDigits: 0 },
        )} total committed`}
        rows={vendors}
        columns={VENDOR_COLUMNS}
        search={filter}
        onSearchChange={setFilter}
        searchText={(v) => [v.title, v.partner?.name ?? "", v.partner?.socioEconomic ?? ""].join(" ")}
        searchPlaceholder="Filter by vendor, title, socio-econ…"
        onRowClick={openDetail}
        rowActions={rowActions}
        onNew={canEdit ? openCreate : undefined}
        newLabel="New Vendor Contract"
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
                      if (!window.confirm(`Delete ${ids.length} vendor contract${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
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
        emptyIcon={Handshake}
        emptyTitle="No vendor contracts yet"
        emptyDescription="Add the first subcontract to start the vendor register."
      />

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

      {/* Detail drawer — issue-style: inline-editable fields + Comments + Activity.
          Replaces the old edit dialog as the primary row-detail view. */}
      {openVendor && (
        <PmEntityDrawer
          key={openVendor.id}
          orgId={orgId}
          projectId={projectId}
          subjectType="vendor"
          subjectId={openVendor.id}
          title={openVendor.title}
          code={null}
          patchPath={`${apiBase}/${openVendor.id}`}
          fields={vendorFields(openVendor)}
          open={openVendorId !== null}
          onOpenChange={(o) => !o && setOpenVendorId(null)}
          onSaved={() => void refetch()}
        />
      )}

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
    </>
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

          {/* Funded + Invoiced (drives % burned) */}
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Funded to date ($)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  step="any"
                  value={form.fundedValue}
                  onChange={(e) => setForm((f) => ({ ...f, fundedValue: e.target.value }))}
                  placeholder="0"
                />
              )}
            </FormField>
            <FormField label="Invoiced to date ($)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  step="any"
                  value={form.invoicedValue}
                  onChange={(e) => setForm((f) => ({ ...f, invoicedValue: e.target.value }))}
                  placeholder="0"
                />
              )}
            </FormField>
          </div>

          {/* Agreement + payment terms */}
          <div className="grid grid-cols-3 gap-4">
            <FormField label="Agmt type">
              {(p) => (
                <Input
                  {...p}
                  value={form.agmtType}
                  onChange={(e) => setForm((f) => ({ ...f, agmtType: e.target.value }))}
                  placeholder="SUBK / MSA / PO"
                />
              )}
            </FormField>
            <FormField label="Agmt number">
              {(p) => (
                <Input
                  {...p}
                  value={form.agmtNumber}
                  onChange={(e) => setForm((f) => ({ ...f, agmtNumber: e.target.value }))}
                  placeholder="SUB-2026-014"
                />
              )}
            </FormField>
            <FormField label="Payment terms">
              {(p) => (
                <Input
                  {...p}
                  value={form.paymentTerms}
                  onChange={(e) => setForm((f) => ({ ...f, paymentTerms: e.target.value }))}
                  placeholder="Net 30"
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

          {/* NDA + POC (partner-level) */}
          <div className="grid grid-cols-2 items-end gap-4">
            <label className="flex items-center gap-2 py-2 text-sm font-medium">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary,#2563eb)]"
                checked={form.ndaOnFile}
                onChange={(e) => setForm((f) => ({ ...f, ndaOnFile: e.target.checked }))}
              />
              NDA on file
            </label>
            <FormField label="NDA expiry">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.ndaExpiry}
                  onChange={(e) => setForm((f) => ({ ...f, ndaExpiry: e.target.value }))}
                />
              )}
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="POC name">
              {(p) => (
                <Input
                  {...p}
                  value={form.pocName}
                  onChange={(e) => setForm((f) => ({ ...f, pocName: e.target.value }))}
                  placeholder="Primary contact"
                />
              )}
            </FormField>
            <FormField label="POC email">
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  value={form.pocEmail}
                  onChange={(e) => setForm((f) => ({ ...f, pocEmail: e.target.value }))}
                  placeholder="name@vendor.com"
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
