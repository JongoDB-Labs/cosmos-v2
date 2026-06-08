"use client";
import { useCallback, useState } from "react";
import { Copy, Eye } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import type { ColumnDef } from "@tanstack/react-table";
import type { ActionMenuGroup } from "@/components/ui/action-menu";
import { InvoiceBuilderDialog } from "./invoice-builder-dialog";
import { InvoiceDetailDialog } from "./invoice-detail-dialog";

const fmt = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );

type InvoiceRow = {
  id: string;
  number: string;
  billToName: string;
  status: string;
  total: string;
  amountPaid: string;
  dueDate: string | null;
};

type Aging = {
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d90_plus: string;
  totalOutstanding: string;
};

const STATUS_TONE: Record<string, BadgeVariant> = {
  DRAFT: "neutral",
  SENT: "progress",
  PARTIAL: "review",
  PAID: "done",
  VOID: "critical",
};

export function InvoicesDashboard({ orgId }: { orgId: string }) {
  const [builderOpen, setBuilderOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const invoicesQ = useQuery({
    queryKey: useOrgQueryKey("invoices"),
    queryFn: () =>
      jsonFetch<{ data: InvoiceRow[] }>(`/api/v1/orgs/${orgId}/invoices`).then((r) => r.data),
  });

  const agingQ = useQuery({
    queryKey: useOrgQueryKey("invoices", "aging"),
    queryFn: () =>
      jsonFetch<{ data: Aging }>(`/api/v1/orgs/${orgId}/invoices/aging`).then((r) => r.data),
  });

  const columns: ColumnDef<InvoiceRow>[] = [
    { accessorKey: "number", header: "Invoice" },
    { accessorKey: "billToName", header: "Bill to" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={STATUS_TONE[row.original.status] ?? "neutral"}>
          {row.original.status}
        </Badge>
      ),
    },
    {
      accessorKey: "total",
      header: "Total",
      cell: ({ row }) => <span className="tabular-nums">{fmt(row.original.total)}</span>,
    },
    {
      id: "balance",
      header: "Balance",
      cell: ({ row }) => (
        <span className="tabular-nums">
          {fmt(Number(row.original.total) - Number(row.original.amountPaid))}
        </span>
      ),
    },
    {
      accessorKey: "dueDate",
      header: "Due",
      cell: ({ row }) =>
        row.original.dueDate
          ? new Date(row.original.dueDate).toLocaleDateString()
          : "—",
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button size="sm" variant="ghost" onClick={() => setDetailId(row.original.id)}>
          View
        </Button>
      ),
    },
  ];

  const rowActions = useCallback(
    (r: InvoiceRow): ActionMenuGroup[] => [
      {
        items: [
          {
            label: "View invoice",
            icon: Eye,
            onClick: () => setDetailId(r.id),
          },
          {
            label: "Copy invoice number",
            icon: Copy,
            onClick: () => {
              void navigator.clipboard?.writeText(r.number);
            },
          },
        ],
      },
    ],
    [],
  );

  if (invoicesQ.isError) {
    return (
      <div className="p-6">
        <LoadError onRetry={() => invoicesQ.refetch()} />
      </div>
    );
  }

  const aging = agingQ.data;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Invoices</h2>
        <Button onClick={() => setBuilderOpen(true)}>New invoice</Button>
      </div>

      {/* AR-aging summary */}
      {aging && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          {[
            { label: "Current", v: aging.current },
            { label: "1–30", v: aging.d1_30 },
            { label: "31–60", v: aging.d31_60 },
            { label: "61–90", v: aging.d61_90 },
            { label: "90+", v: aging.d90_plus },
            { label: "Outstanding", v: aging.totalOutstanding, bold: true },
          ].map((b) => (
            <div
              key={b.label}
              className={`rounded-md border bg-background p-3 ${b.bold ? "border-primary/40" : ""}`}
            >
              <div className="text-xs text-muted-foreground">{b.label}</div>
              <div className={`tabular-nums ${b.bold ? "text-lg font-semibold" : "text-base"}`}>
                {fmt(b.v)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Invoice list */}
      {invoicesQ.isLoading ? (
        <Skeleton className="h-64 rounded-lg" />
      ) : (
        <DataTable
          columns={columns}
          data={invoicesQ.data ?? []}
          rowActions={rowActions}
          emptyState={<EmptyState title="No invoices yet — create your first one." />}
        />
      )}

      <InvoiceBuilderDialog orgId={orgId} open={builderOpen} onOpenChange={setBuilderOpen} />
      <InvoiceDetailDialog
        orgId={orgId}
        invoiceId={detailId}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      />
    </div>
  );
}
