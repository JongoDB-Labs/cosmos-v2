"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import type { ColumnDef } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";

const fmt = (v: number | string | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v ?? 0),
  );

type Account = {
  id: string;
  code: string;
  name: string;
  type: string;
  normalBalance: string;
  isActive: boolean;
};
type JournalLine = {
  id: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  account: { code: string; name: string };
};
type JournalEntry = {
  id: string;
  entryNumber: number;
  date: string;
  memo: string;
  source: string;
  lines: JournalLine[];
};
type TrialBalance = {
  rows: {
    accountId: string;
    code?: string;
    name?: string;
    debit: string;
    credit: string;
  }[];
  totalDebits: string;
  totalCredits: string;
};
type ProfitLoss = { revenue: string; expense: string; netIncome: string };
type BalanceSheet = {
  assets: string;
  liabilities: string;
  equity: string;
  netIncome: string;
};
type Tab = "accounts" | "journal" | "reports";

export function AccountingDashboard({ orgId }: { orgId: string }) {
  const [tab, setTab] = useState<Tab>("reports");
  const accountsKey = useOrgQueryKey("accounting", "accounts");
  const journalKey = useOrgQueryKey("accounting", "journal");
  const tbKey = useOrgQueryKey("accounting", "trial-balance");
  const plKey = useOrgQueryKey("accounting", "profit-loss");
  const bsKey = useOrgQueryKey("accounting", "balance-sheet");

  const accountsQ = useQuery({
    queryKey: accountsKey,
    queryFn: () =>
      jsonFetch<{ data: Account[] }>(
        `/api/v1/orgs/${orgId}/accounting/accounts`,
      ).then((r) => r.data),
  });
  const journalQ = useQuery({
    queryKey: journalKey,
    queryFn: () =>
      jsonFetch<{ data: JournalEntry[] }>(
        `/api/v1/orgs/${orgId}/accounting/journal-entries`,
      ).then((r) => r.data),
  });
  const tbQ = useQuery({
    queryKey: tbKey,
    queryFn: () =>
      jsonFetch<TrialBalance>(
        `/api/v1/orgs/${orgId}/accounting/reports/trial-balance`,
      ),
  });
  const plQ = useQuery({
    queryKey: plKey,
    queryFn: () =>
      jsonFetch<ProfitLoss>(
        `/api/v1/orgs/${orgId}/accounting/reports/profit-loss`,
      ),
  });
  const bsQ = useQuery({
    queryKey: bsKey,
    queryFn: () =>
      jsonFetch<BalanceSheet>(
        `/api/v1/orgs/${orgId}/accounting/reports/balance-sheet`,
      ),
  });

  const backfill = useOrgMutation<
    { revenues: { total: number }; expenses: { total: number } },
    Error,
    void
  >({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/accounting/backfill`, {
        method: "POST",
      }),
    invalidate: [["accounting"]],
    onError: (e) => notifyError(e, "Couldn't run the backfill."),
  });

  if (
    accountsQ.isError ||
    journalQ.isError ||
    tbQ.isError ||
    plQ.isError ||
    bsQ.isError
  ) {
    return (
      <div className="p-6">
        <LoadError
          onRetry={() => {
            accountsQ.refetch();
            journalQ.refetch();
            tbQ.refetch();
            plQ.refetch();
            bsQ.refetch();
          }}
        />
      </div>
    );
  }

  const accountCols: ColumnDef<Account>[] = [
    { accessorKey: "code", header: "Code" },
    { accessorKey: "name", header: "Name" },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => (
        <Badge variant="neutral" className="text-xs">
          {row.original.type}
        </Badge>
      ),
    },
    { accessorKey: "normalBalance", header: "Normal" },
  ];

  const journalCols: ColumnDef<JournalEntry>[] = [
    { accessorKey: "entryNumber", header: "#" },
    {
      accessorKey: "date",
      header: "Date",
      cell: ({ row }) => new Date(row.original.date).toLocaleDateString(),
    },
    {
      accessorKey: "memo",
      header: "Memo",
      cell: ({ row }) => (
        <span className="block max-w-64 truncate">{row.original.memo}</span>
      ),
    },
    {
      accessorKey: "source",
      header: "Source",
      cell: ({ row }) => (
        <Badge variant="neutral" className="text-xs">
          {row.original.source}
        </Badge>
      ),
    },
    {
      id: "total",
      header: "Amount",
      cell: ({ row }) =>
        fmt(
          row.original.lines
            .filter((l) => l.direction === "DEBIT")
            .reduce((s, l) => s + Number(l.amount), 0),
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-lg border bg-muted/50 p-0.5">
          {(["reports", "journal", "accounts"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "reports"
                ? "Reports"
                : t === "journal"
                  ? "Journal"
                  : "Chart of Accounts"}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <Button
            size="sm"
            variant="outline"
            onClick={() => backfill.mutate()}
            disabled={backfill.isPending}
          >
            <RefreshCw
              className={`size-4 ${backfill.isPending ? "animate-spin" : ""}`}
            />{" "}
            {backfill.isPending ? "Posting…" : "Sync from Revenue/Expense"}
          </Button>
        </div>
      </div>

      {tab === "reports" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <ReportCard
            title="Profit & Loss"
            loading={plQ.isLoading}
            rows={[
              ["Revenue", plQ.data?.revenue],
              ["Expenses", plQ.data?.expense],
              ["Net income", plQ.data?.netIncome],
            ]}
          />
          <ReportCard
            title="Balance Sheet"
            loading={bsQ.isLoading}
            rows={[
              ["Assets", bsQ.data?.assets],
              ["Liabilities", bsQ.data?.liabilities],
              ["Equity", bsQ.data?.equity],
              ["Net income", bsQ.data?.netIncome],
            ]}
          />
          <ReportCard
            title="Trial Balance"
            loading={tbQ.isLoading}
            rows={[
              ["Total debits", tbQ.data?.totalDebits],
              ["Total credits", tbQ.data?.totalCredits],
              [
                "Balanced",
                tbQ.data &&
                Math.abs(
                  Number(tbQ.data.totalDebits) - Number(tbQ.data.totalCredits),
                ) < 0.005
                  ? "✓"
                  : "—",
              ],
            ]}
          />
        </div>
      )}

      {tab === "journal" &&
        (journalQ.isLoading ? (
          <Skeleton className="h-64 rounded-lg" />
        ) : (
          <DataTable
            columns={journalCols}
            data={journalQ.data ?? []}
            emptyState={
              <EmptyState title="No journal entries yet. Run a sync." />
            }
          />
        ))}

      {tab === "accounts" &&
        (accountsQ.isLoading ? (
          <Skeleton className="h-64 rounded-lg" />
        ) : (
          <DataTable
            columns={accountCols}
            data={accountsQ.data ?? []}
            emptyState={<EmptyState title="No accounts yet." />}
          />
        ))}
    </div>
  );
}

function ReportCard({
  title,
  rows,
  loading,
}: {
  title: string;
  rows: [string, string | number | null | undefined][];
  loading: boolean;
}) {
  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {loading ? (
        <Skeleton className="h-24 rounded" />
      ) : (
        <dl className="flex flex-col gap-2 text-sm">
          {rows.map(([label, val]) => (
            <div key={label} className="flex items-center justify-between">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium tabular-nums">
                {val === "✓" || val === "—"
                  ? val
                  : new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                    }).format(Number(val ?? 0))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
