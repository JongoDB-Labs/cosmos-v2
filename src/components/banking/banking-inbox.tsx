"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { BankRulesDialog } from "./bank-rules-dialog";
import type { ColumnDef } from "@tanstack/react-table";

const fmtCurrency = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );

type BankAccount = {
  id: string;
  name: string;
  institution?: string | null;
  mask?: string | null;
  currency: string;
  isActive: boolean;
};

type Txn = {
  id: string;
  postedDate: string;
  amount: string;
  description: string;
  suggestedCategory: string | null;
  status: string;
};

type MatchCandidate = {
  id: string;
  kind: "expense" | "revenue";
  amount: string;
  date: string;
  label: string;
};

type ReconBucket = { count: number; sum: string };
type ReconSummary = {
  reconciled: ReconBucket;
  unreconciled: ReconBucket;
  excluded: ReconBucket;
  total: ReconBucket;
  reconciledPct: number;
};

export function BankingInbox({ orgId }: { orgId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [catMap, setCatMap] = useState<Record<string, string>>({});
  const [matchTxn, setMatchTxn] = useState<Txn | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);

  const accountsKey = useOrgQueryKey("bank", "accounts");
  const accountsQ = useQuery({
    queryKey: accountsKey,
    queryFn: () =>
      jsonFetch<{ data: BankAccount[] }>(
        `/api/v1/orgs/${orgId}/bank-accounts`,
      ).then((r) => {
        if (r.data.length > 0 && selectedId === null) {
          setSelectedId(r.data[0].id);
        }
        return r.data;
      }),
  });

  const txnsKey = useOrgQueryKey("bank", selectedId ?? "", "transactions");
  const txnsQ = useQuery({
    queryKey: txnsKey,
    enabled: !!selectedId,
    queryFn: () =>
      jsonFetch<{ data: Txn[] }>(
        `/api/v1/orgs/${orgId}/bank-accounts/${selectedId}/transactions?status=IMPORTED`,
      ).then((r) => {
        // Pre-fill category map from suggestedCategory for rows not yet edited
        setCatMap((prev) => {
          const next = { ...prev };
          for (const t of r.data) {
            if (!(t.id in next)) {
              next[t.id] = t.suggestedCategory ?? "";
            }
          }
          return next;
        });
        return r.data;
      }),
  });

  // Reconciliation progress for the selected account.
  const reconKey = useOrgQueryKey("bank", selectedId ?? "", "reconciliation");
  const reconQ = useQuery({
    queryKey: reconKey,
    enabled: !!selectedId,
    queryFn: () =>
      jsonFetch<{ data: ReconSummary }>(
        `/api/v1/orgs/${orgId}/bank-accounts/${selectedId}/reconciliation`,
      ).then((r) => r.data),
  });

  // Match-candidate list for the txn whose dialog is open.
  const candidatesKey = useOrgQueryKey("bank", "candidates", matchTxn?.id ?? "");
  const candidatesQ = useQuery({
    queryKey: candidatesKey,
    enabled: matchTxn !== null,
    queryFn: () =>
      jsonFetch<{ data: MatchCandidate[] }>(
        `/api/v1/orgs/${orgId}/bank-transactions/${matchTxn!.id}/candidates`,
      ).then((r) => r.data),
  });

  const categorize = useOrgMutation<unknown, Error, string>({
    mutationFn: (txnId: string) =>
      jsonFetch(`/api/v1/orgs/${orgId}/bank-transactions/${txnId}/categorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: catMap[txnId] ?? "" }),
      }),
    invalidate: [
      ["bank", selectedId ?? "", "transactions"],
      ["bank", selectedId ?? "", "reconciliation"],
    ],
    onError: (e) => notifyError(e, "Couldn't post transaction."),
  });

  const exclude = useOrgMutation<unknown, Error, string>({
    mutationFn: (txnId: string) =>
      jsonFetch(`/api/v1/orgs/${orgId}/bank-transactions/${txnId}/exclude`, {
        method: "POST",
      }),
    invalidate: [
      ["bank", selectedId ?? "", "transactions"],
      ["bank", selectedId ?? "", "reconciliation"],
    ],
    onError: (e) => notifyError(e, "Couldn't exclude transaction."),
  });

  const match = useOrgMutation<
    unknown,
    Error,
    { txnId: string; targetType: "expense" | "revenue"; targetId: string }
  >({
    mutationFn: ({ txnId, targetType, targetId }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/bank-transactions/${txnId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType, targetId }),
      }),
    invalidate: [
      ["bank", selectedId ?? "", "transactions"],
      ["bank", selectedId ?? "", "reconciliation"],
    ],
    onSuccess: () => setMatchTxn(null),
    onError: (e) => notifyError(e, "Couldn't match transaction."),
  });

  if (accountsQ.isError || txnsQ.isError) {
    return (
      <div className="p-6">
        <LoadError
          onRetry={() => {
            accountsQ.refetch();
            txnsQ.refetch();
          }}
        />
      </div>
    );
  }

  if (accountsQ.isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  const accounts = accountsQ.data ?? [];

  if (accounts.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No bank accounts yet — add one and import a statement."
        />
      </div>
    );
  }

  const columns: ColumnDef<Txn>[] = [
    {
      accessorKey: "postedDate",
      header: "Date",
      cell: ({ row }) =>
        new Date(row.original.postedDate).toLocaleDateString(),
    },
    {
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="block max-w-64 truncate">{row.original.description}</span>
      ),
    },
    {
      accessorKey: "amount",
      header: "Amount",
      cell: ({ row }) => {
        const n = Number(row.original.amount);
        const formatted = fmtCurrency(row.original.amount);
        return (
          <span className={n < 0 ? "text-destructive tabular-nums" : "tabular-nums"}>
            {formatted}
          </span>
        );
      },
    },
    {
      id: "category",
      header: "Category / source",
      cell: ({ row }) => {
        const isOutflow = Number(row.original.amount) < 0;
        return (
          <Input
            className="h-7 min-w-32 text-xs"
            aria-label={isOutflow ? "Category" : "Source"}
            placeholder={isOutflow ? "Category…" : "Source…"}
            value={catMap[row.original.id] ?? ""}
            onChange={(e) =>
              setCatMap((prev) => ({
                ...prev,
                [row.original.id]: e.target.value,
              }))
            }
          />
        );
      },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const txnId = row.original.id;
        const cat = catMap[txnId] ?? "";
        const isOutflow = Number(row.original.amount) < 0;
        // Only the row whose mutation is in flight is busy — other rows stay
        // interactive (react-query exposes the in-flight mutation's variables).
        const rowBusy =
          (categorize.isPending && categorize.variables === txnId) ||
          (exclude.isPending && exclude.variables === txnId) ||
          (match.isPending && match.variables?.txnId === txnId);
        return (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="default"
              disabled={cat.trim() === "" || rowBusy}
              onClick={() => categorize.mutate(txnId)}
            >
              {isOutflow ? "Add as expense" : "Add as revenue"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={rowBusy}
              onClick={() => setMatchTxn(row.original)}
            >
              Match
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={rowBusy}
              onClick={() => exclude.mutate(txnId)}
            >
              Exclude
            </Button>
          </div>
        );
      },
    },
  ];

  const matchIsOutflow = matchTxn ? Number(matchTxn.amount) < 0 : false;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Account selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground font-medium shrink-0">Account:</span>
        <div className="flex items-center rounded-lg border bg-muted/50 p-0.5 gap-0.5 flex-wrap">
          {accounts.map((acct) => (
            <button
              key={acct.id}
              onClick={() => setSelectedId(acct.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                selectedId === acct.id
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {acct.name}
              {acct.mask ? ` ···${acct.mask}` : ""}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setRulesOpen(true)}
        >
          Rules
        </Button>
      </div>

      {/* Reconciliation summary */}
      {reconQ.data && reconQ.data.total.count > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Reconciliation</span>
            <span className="text-sm text-muted-foreground tabular-nums">
              {reconQ.data.reconciledPct}% reconciled
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${reconQ.data.reconciledPct}%` }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ReconStat label="Unreconciled" bucket={reconQ.data.unreconciled} />
            <ReconStat label="Reconciled" bucket={reconQ.data.reconciled} />
            <ReconStat label="Excluded" bucket={reconQ.data.excluded} />
            <ReconStat label="Total" bucket={reconQ.data.total} />
          </div>
        </div>
      )}

      {/* Review queue */}
      {txnsQ.isLoading ? (
        <Skeleton className="h-64 rounded-lg" />
      ) : (
        <DataTable
          columns={columns}
          data={txnsQ.data ?? []}
          emptyState={
            <EmptyState title="No transactions to review — all caught up." />
          }
        />
      )}

      {/* Match dialog */}
      <Dialog
        open={matchTxn !== null}
        onOpenChange={(open) => {
          if (!open) setMatchTxn(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Match transaction</DialogTitle>
            <DialogDescription>
              {matchTxn
                ? `Link this ${matchIsOutflow ? "payment" : "deposit"} (${fmtCurrency(
                    matchTxn.amount,
                  )} · ${matchTxn.description}) to an existing ${
                    matchIsOutflow ? "expense" : "revenue"
                  }.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {candidatesQ.isLoading ? (
            <Skeleton className="h-40 rounded-lg" />
          ) : (candidatesQ.data ?? []).length === 0 ? (
            <EmptyState
              title={`No ${matchIsOutflow ? "expenses" : "revenue"} to match against.`}
            />
          ) : (
            <div className="flex max-h-80 flex-col gap-1 overflow-auto">
              {(candidatesQ.data ?? []).map((c) => (
                <button
                  key={c.id}
                  disabled={match.isPending}
                  onClick={() =>
                    matchTxn &&
                    match.mutate({
                      txnId: matchTxn.id,
                      targetType: c.kind,
                      targetId: c.id,
                    })
                  }
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <span className="truncate">{c.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {fmtCurrency(c.amount)} · {new Date(c.date).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <BankRulesDialog
        orgId={orgId}
        open={rulesOpen}
        onOpenChange={setRulesOpen}
      />
    </div>
  );
}

function ReconStat({ label, bucket }: { label: string; bucket: ReconBucket }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{bucket.count}</div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {fmtCurrency(bucket.sum)}
      </div>
    </div>
  );
}
