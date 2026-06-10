"use client";
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { ColumnDef } from "@tanstack/react-table";
import type { ActionMenuGroup } from "@/components/ui/action-menu";

const fmt = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );
const pct = (fraction: string) => `${(Number(fraction) * 100).toFixed(3).replace(/\.?0+$/, "")}%`;

type TaxRate = {
  id: string;
  name: string;
  rate: string;
  jurisdiction: string | null;
  isDefault: boolean;
  isActive: boolean;
};
type Liability = {
  total: string;
  byMonth: { month: string; collected: string }[];
};

export function TaxDashboard({ orgId }: { orgId: string }) {
  const ratesQ = useQuery({
    queryKey: useOrgQueryKey("tax-rates"),
    queryFn: () =>
      jsonFetch<{ data: TaxRate[] }>(`/api/v1/orgs/${orgId}/tax-rates`).then((r) => r.data),
  });
  const liabilityQ = useQuery({
    queryKey: useOrgQueryKey("tax", "liability"),
    // jsonFetch already unwraps the single-key { data } envelope.
    queryFn: () => jsonFetch<Liability>(`/api/v1/orgs/${orgId}/tax/liability`),
  });

  const remove = useOrgMutation<unknown, Error, string>({
    mutationFn: (id: string) =>
      jsonFetch(`/api/v1/orgs/${orgId}/tax-rates/${id}`, { method: "DELETE" }),
    invalidate: [["tax-rates"]],
    onError: (e) => notifyError(e, "Couldn't delete the tax rate."),
  });

  const cols: ColumnDef<TaxRate>[] = [
    {
      id: "name",
      header: "Name",
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          {row.original.name}
          {row.original.isDefault && <Badge variant="strategic">default</Badge>}
          {!row.original.isActive && <Badge variant="neutral">inactive</Badge>}
        </span>
      ),
    },
    {
      accessorKey: "rate",
      header: "Rate",
      cell: ({ row }) => <span className="tabular-nums">{pct(row.original.rate)}</span>,
    },
    { accessorKey: "jurisdiction", header: "Jurisdiction", cell: ({ row }) => row.original.jurisdiction ?? "—" },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="ghost"
          disabled={remove.isPending && remove.variables === row.original.id}
          onClick={() => remove.mutate(row.original.id)}
        >
          Delete
        </Button>
      ),
    },
  ];

  const rowActions = useCallback(
    (r: TaxRate): ActionMenuGroup[] => [
      {
        items: [
          {
            label: "Delete",
            icon: Trash2,
            variant: "destructive",
            disabled: remove.isPending && remove.variables === r.id,
            onClick: () => remove.mutate(r.id),
          },
        ],
      },
    ],
    [remove],
  );

  const liability = liabilityQ.data;

  return (
    <div className="flex flex-col gap-8 p-6">
      {/* Liability */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Sales tax liability</h3>
        {liabilityQ.isLoading || !liability ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">Owed (Sales Tax Payable)</div>
              <div className="text-2xl font-semibold tabular-nums">{fmt(liability.total)}</div>
            </div>
            {liability.byMonth.length > 0 && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {liability.byMonth.slice(-8).map((m) => (
                  <div key={m.month} className="rounded-md border bg-background p-3">
                    <div className="text-xs text-muted-foreground">{m.month}</div>
                    <div className="tabular-nums">{fmt(m.collected)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Rates */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Tax rates</h3>
        <NewTaxRateForm orgId={orgId} />
        {ratesQ.isLoading ? (
          <Skeleton className="h-32 rounded-lg" />
        ) : (
          <DataTable
            columns={cols}
            data={ratesQ.data ?? []}
            rowActions={rowActions}
            emptyState={<EmptyState title="No tax rates yet — add one above." />}
          />
        )}
      </section>
    </div>
  );
}

function NewTaxRateForm({ orgId }: { orgId: string }) {
  const [name, setName] = useState("");
  const [ratePct, setRatePct] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  const create = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/tax-rates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          rate: (Number(ratePct) || 0) / 100, // percent → fraction
          jurisdiction: jurisdiction.trim() || null,
          isDefault,
        }),
      }),
    invalidate: [["tax-rates"]],
    onSuccess: () => {
      setName("");
      setRatePct("");
      setJurisdiction("");
      setIsDefault(false);
    },
    onError: (e) => notifyError(e, "Couldn't add the tax rate."),
  });

  const valid = name.trim() !== "" && Number(ratePct) >= 0 && Number(ratePct) <= 100;

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
      <div className="flex flex-1 flex-col gap-1">
        <Label className="text-xs" htmlFor="tax-rate-name">Name</Label>
        <Input id="tax-rate-name" className="h-8" value={name} onChange={(e) => setName(e.target.value)} placeholder="CA Sales Tax" />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs" htmlFor="tax-rate-pct">Rate %</Label>
        <Input
          id="tax-rate-pct"
          className="h-8 w-20"
          type="number"
          step="0.001"
          min="0"
          max="100"
          value={ratePct}
          onChange={(e) => setRatePct(e.target.value)}
          placeholder="8.25"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs" htmlFor="tax-rate-jurisdiction">Jurisdiction</Label>
        <Input id="tax-rate-jurisdiction" className="h-8 w-32" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="CA" />
      </div>
      <label className="flex items-center gap-1.5 pb-1.5 text-xs">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Default
      </label>
      <Button size="sm" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
        Add rate
      </Button>
    </div>
  );
}
