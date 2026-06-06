"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Trash2,
  Pencil,
  Download,
  FileSignature,
  CheckCircle2,
} from "lucide-react";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";

interface ContractsListProps {
  orgId: string;
}

// Local shapes mirror the Contracts API (route.ts + Prisma `Contract`), which
// differ from the aspirational `Contract` in src/types/models.ts (no currency,
// terms, productId, or docusign fields there). Keep these aligned with the API.
interface ContractPartner {
  id: string;
  name: string;
}

interface ContractProduct {
  id: string;
  name: string;
}

interface Contract {
  id: string;
  title: string;
  value: string | null;
  currency: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  terms: string | null;
  notes: string | null;
  partnerId: string | null;
  productId: string | null;
  partner: ContractPartner | null;
  product: ContractProduct | null;
  docusignStatus: string | null;
  signedAt: string | null;
}

// Partners/products list endpoints return bare arrays. We only need id + name
// to populate the pickers.
interface PartnerOption {
  id: string;
  name: string;
}

interface ProductOption {
  id: string;
  name: string;
}

// Contract.status is a free string on the model (default "draft"); these are
// the conventional values surfaced in the UI. Unknown values fall through to a
// neutral badge and the raw label.
const STATUS_OPTIONS = [
  "draft",
  "active",
  "signed",
  "completed",
  "cancelled",
] as const;

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  draft: "neutral",
  active: "progress",
  signed: "done",
  completed: "done",
  cancelled: "critical",
};

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatCurrency(value: number | string | null, currency: string): string {
  if (value == null) return "-";
  const n = Number(value);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(n);
  } catch {
    // Intl throws on an invalid currency code; fall back to a plain number.
    return `${n.toLocaleString()} ${currency}`;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleDateString();
}

interface ContractFormData {
  title: string;
  value: string;
  currency: string;
  status: string;
  startDate: string;
  endDate: string;
  terms: string;
  notes: string;
  partnerId: string;
  productId: string;
}

const emptyForm: ContractFormData = {
  title: "",
  value: "",
  currency: "USD",
  status: "draft",
  startDate: "",
  endDate: "",
  terms: "",
  notes: "",
  partnerId: "",
  productId: "",
};

export function ContractsList({ orgId }: ContractsListProps) {
  const { can } = usePermissions();
  const canCreate = can(Permission.CRM_CREATE);
  const canUpdate = can(Permission.CRM_UPDATE);
  const canDelete = can(Permission.CRM_DELETE);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<ContractFormData>(emptyForm);
  // When set, the dialog edits the existing row (PUT). When null, it creates a
  // new row (POST).
  const [editing, setEditing] = useState<string | null>(null);

  const contractsKey = useOrgQueryKey("contracts");
  const partnersKey = useOrgQueryKey("contracts", "partners");
  const productsKey = useOrgQueryKey("contracts", "products");

  const contractsQ = useQuery({
    queryKey: contractsKey,
    queryFn: () => jsonFetch<Contract[]>(`/api/v1/orgs/${orgId}/contracts`),
  });

  // Picker data — both endpoints return bare arrays. Failures are non-fatal:
  // the form still works, just without a partner/product to choose.
  const partnersQ = useQuery({
    queryKey: partnersKey,
    queryFn: () => jsonFetch<PartnerOption[]>(`/api/v1/orgs/${orgId}/partners`),
  });

  const productsQ = useQuery({
    queryKey: productsKey,
    queryFn: () => jsonFetch<ProductOption[]>(`/api/v1/orgs/${orgId}/products`),
  });

  const contracts = contractsQ.data ?? [];
  const partners = partnersQ.data ?? [];
  const products = productsQ.data ?? [];

  function buildBody(f: ContractFormData) {
    const parsedValue = f.value.trim() === "" ? null : parseFloat(f.value);
    return {
      title: f.title.trim(),
      value: Number.isFinite(parsedValue as number) ? parsedValue : null,
      currency: f.currency.trim() || "USD",
      status: f.status || "draft",
      startDate: f.startDate ? new Date(f.startDate).toISOString() : null,
      endDate: f.endDate ? new Date(f.endDate).toISOString() : null,
      terms: f.terms.trim() || null,
      notes: f.notes.trim() || null,
      partnerId: f.partnerId || null,
      productId: f.productId || null,
    };
  }

  const createMutation = useOrgMutation<Contract, Error, ContractFormData>({
    mutationFn: (f) =>
      jsonFetch(`/api/v1/orgs/${orgId}/contracts`, {
        method: "POST",
        body: JSON.stringify(buildBody(f)),
      }),
    invalidate: [["contracts"]],
    onSuccess: () => {
      setDialogOpen(false);
      setForm(emptyForm);
      setEditing(null);
    },
    onError: (err) => notifyError(err, "Couldn't create the contract."),
  });

  const updateMutation = useOrgMutation<
    Contract,
    Error,
    { id: string; form: ContractFormData }
  >({
    mutationFn: ({ id, form: f }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/contracts/${id}`, {
        method: "PUT",
        body: JSON.stringify(buildBody(f)),
      }),
    invalidate: [["contracts"]],
    onSuccess: () => {
      setDialogOpen(false);
      setForm(emptyForm);
      setEditing(null);
    },
    onError: (err) => notifyError(err, "Couldn't update the contract."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/contracts/${id}`, { method: "DELETE" }),
    invalidate: [["contracts"]],
    onError: (err) => notifyError(err, "Couldn't delete the contract."),
  });

  const saving = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = () => {
    if (editing) {
      updateMutation.mutate({ id: editing, form });
    } else {
      createMutation.mutate(form);
    }
  };

  const handleEdit = (c: Contract) => {
    setEditing(c.id);
    setForm({
      title: c.title,
      value: c.value == null ? "" : String(c.value),
      currency: c.currency || "USD",
      status: c.status || "draft",
      startDate: c.startDate ? new Date(c.startDate).toISOString().split("T")[0] : "",
      endDate: c.endDate ? new Date(c.endDate).toISOString().split("T")[0] : "",
      terms: c.terms ?? "",
      notes: c.notes ?? "",
      partnerId: c.partnerId ?? "",
      productId: c.productId ?? "",
    });
    setDialogOpen(true);
  };

  // Reset edit state + clear the form whenever the dialog closes so the next
  // "New contract" starts blank and isn't bound to a stale row id.
  const handleDialogChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setEditing(null);
      setForm(emptyForm);
    }
  };

  if (contractsQ.isError) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <LoadError onRetry={() => contractsQ.refetch()} />
      </div>
    );
  }

  if (contractsQ.isLoading) {
    return (
      <div className="flex flex-col gap-6 p-6">
        {/* Minimal skeleton mirrors the content's first row (right-aligned
            New contract action) so real content grows DOWNWARD (avoids CLS).
            Title is owned by PageShell. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
          <Skeleton className="h-9 w-36 rounded-lg" />
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  const columns: ColumnDef<Contract>[] = [
    {
      accessorKey: "title",
      header: "Title",
      cell: ({ row }) => (
        <span className="block max-w-56 truncate font-medium">{row.original.title}</span>
      ),
    },
    {
      accessorKey: "partner",
      header: "Partner",
      cell: ({ row }) => row.original.partner?.name || "-",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge
          variant={STATUS_VARIANT[row.original.status] ?? "neutral"}
          showDot={false}
          className="text-xs"
        >
          {statusLabel(row.original.status)}
        </Badge>
      ),
    },
    {
      accessorKey: "signature",
      header: "Signature",
      enableSorting: false,
      cell: ({ row }) => {
        const c = row.original;
        if (c.signedAt) {
          return (
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5 text-green-500" />
              Signed {new Date(c.signedAt).toLocaleDateString()}
            </span>
          );
        }
        if (c.docusignStatus) {
          return (
            <Badge variant="progress" showDot={false} className="text-xs">
              {statusLabel(c.docusignStatus)}
            </Badge>
          );
        }
        return <span className="text-muted-foreground">-</span>;
      },
    },
    {
      accessorKey: "startDate",
      header: "Start",
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{formatDate(row.original.startDate)}</span>
      ),
    },
    {
      accessorKey: "endDate",
      header: "End",
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{formatDate(row.original.endDate)}</span>
      ),
    },
    {
      accessorKey: "value",
      header: "Value",
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-medium md:text-right md:block">
          {formatCurrency(row.original.value, row.original.currency)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => {
        const c = row.original;
        const groups: ActionMenuGroup[] = [
          {
            items: [
              ...(canUpdate
                ? [
                    {
                      label: "Edit",
                      icon: Pencil,
                      onClick: () => handleEdit(c),
                    },
                  ]
                : []),
              // PDF generation works without any DocuSign config — the route
              // renders contract data server-side via pdfkit. Open in a new tab
              // so the browser handles the attachment download.
              {
                label: "Download PDF",
                icon: Download,
                onClick: () =>
                  window.open(
                    `/api/v1/orgs/${orgId}/contracts/${c.id}/pdf`,
                    "_blank",
                    "noopener,noreferrer",
                  ),
              },
            ],
          },
          {
            items: [
              ...(canDelete
                ? [
                    {
                      label: "Delete",
                      icon: Trash2,
                      variant: "destructive" as const,
                      onClick: () => {
                        if (
                          typeof window !== "undefined" &&
                          !window.confirm(`Delete contract "${c.title}"?`)
                        ) {
                          return;
                        }
                        deleteMutation.mutate(c.id);
                      },
                    },
                  ]
                : []),
            ],
          },
        ];
        return (
          <div className="flex justify-end group/action">
            <ActionMenu groups={groups}>
              <span />
            </ActionMenu>
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
        {/* Title/subtitle owned by the page shell (PageShell). */}
        {canCreate && (
          <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
            <DialogTrigger
              render={
                <Button>
                  <Plus className="size-4" />
                  New contract
                </Button>
              }
            />
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{editing ? "Edit contract" : "New contract"}</DialogTitle>
              </DialogHeader>
              <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ct-title">Title</Label>
                  <Input
                    id="ct-title"
                    placeholder="e.g. Master Services Agreement"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ct-value">Value</Label>
                    <Input
                      id="ct-value"
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={form.value}
                      onChange={(e) => setForm({ ...form, value: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ct-currency">Currency</Label>
                    <Input
                      id="ct-currency"
                      value={form.currency}
                      maxLength={10}
                      onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Status</Label>
                  <Select
                    value={form.status}
                    onValueChange={(val) =>
                      setForm({ ...form, status: val ?? "draft" })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((s) => (
                        <SelectItem key={s} value={s}>
                          {statusLabel(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label>Start date</Label>
                    <DatePicker
                      value={form.startDate}
                      onValueChange={(date) => setForm({ ...form, startDate: date })}
                      placeholder="Start date"
                      aria-label="Start date"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>End date</Label>
                    <DatePicker
                      value={form.endDate}
                      onValueChange={(date) => setForm({ ...form, endDate: date })}
                      placeholder="End date"
                      aria-label="End date"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Partner</Label>
                  <Select
                    value={form.partnerId || "none"}
                    onValueChange={(val) =>
                      setForm({ ...form, partnerId: !val || val === "none" ? "" : val })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a partner" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— No partner —</SelectItem>
                      {partners.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Product</Label>
                  <Select
                    value={form.productId || "none"}
                    onValueChange={(val) =>
                      setForm({ ...form, productId: !val || val === "none" ? "" : val })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a product" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— No product —</SelectItem>
                      {products.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ct-terms">Terms</Label>
                  <Textarea
                    id="ct-terms"
                    placeholder="Key terms and conditions"
                    value={form.terms}
                    onChange={(e) => setForm({ ...form, terms: e.target.value })}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ct-notes">Notes</Label>
                  <Textarea
                    id="ct-notes"
                    placeholder="Internal notes"
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  />
                </div>

                {/* Read-only signature status when editing an already-sent
                    contract. Sending for signature is intentionally NOT wired
                    up here: POST .../signature requires DocuSign env vars
                    (returns 503 "DocuSign not configured" otherwise) AND a
                    base64-encoded document + signer email/name. Surfacing the
                    status read-only avoids shipping a button that 503s.
                    TODO(docusign): add a "Send for signature" action once
                    DocuSign credentials are configured — collect signer
                    email/name, fetch the PDF from .../pdf, base64-encode it,
                    then POST to .../contracts/{id}/signature. */}
                {editing ? (
                  <SignatureStatus contract={findContract(contracts, editing)} />
                ) : null}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => handleDialogChange(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={saving || !form.title.trim()}>
                  {saving ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <DataTable
        columns={columns}
        data={contracts}
        emptyState={
          <EmptyState
            title="No contracts yet"
            description="Create your first contract to track agreements, value, dates, and signatures."
            action={
              canCreate ? (
                <button
                  type="button"
                  onClick={() => setDialogOpen(true)}
                  className={cn(buttonVariants({ size: "sm" }))}
                >
                  <Plus className="size-4" />
                  New contract
                </button>
              ) : undefined
            }
          />
        }
      />
    </div>
  );
}

function findContract(contracts: Contract[], id: string): Contract | undefined {
  return contracts.find((c) => c.id === id);
}

// Read-only DocuSign signature status block. The signature/status route
// degrades gracefully when DocuSign isn't configured (returns the stored
// status), so we simply render whatever the contract record already holds.
function SignatureStatus({ contract }: { contract: Contract | undefined }) {
  if (!contract || (!contract.docusignStatus && !contract.signedAt)) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <FileSignature className="size-4 text-muted-foreground" />
        Signature status
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {contract.docusignStatus ? (
          <Badge variant="progress" showDot={false} className="text-xs">
            {statusLabel(contract.docusignStatus)}
          </Badge>
        ) : (
          <span>Not sent</span>
        )}
        {contract.signedAt ? (
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="size-3.5 text-green-500" />
            Signed {new Date(contract.signedAt).toLocaleDateString()}
          </span>
        ) : null}
      </div>
    </div>
  );
}
