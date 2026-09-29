"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { StatCard } from "@/components/ui/stat-card";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Receipt } from "lucide-react";
import { dueLabel, isPastDue, outstanding, type BillLike } from "@/lib/payables/bills";

/**
 * What the practice owes.
 *
 * The four figures at the top are disjoint by construction -- paid, owed and
 * past due add up to total -- and they come from the server so they describe
 * the same set of bills the table below is showing, rather than whatever
 * happens to have been fetched.
 */

type Bill = BillLike & {
  id: string;
  reference: string;
  vendorName: string;
  issueDate: string | null;
  paidDate: string | null;
  currency: string;
  project: { key: string; name: string } | null;
  invoice: { number: string; status: string } | null;
};

type Payload = {
  data: Bill[];
  totals: { total: number; paid: number; owed: number; pastDue: number };
  /** The server's date, so "past due" is decided in one place. */
  today: string;
};

const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/** The same date formatter, for a value the lib has already decided is present. */
const fmtDate2 = (iso: string) => fmtDate(iso);

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(`${iso}T00:00:00.000Z`).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";

const STATUS: Record<string, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  PAID: "Paid",
  VOID: "Void",
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "PAID", label: "Paid" },
  { key: "DRAFT", label: "Draft" },
] as const;

export function BillsWorkspace({ orgId }: { orgId: string }) {
  const [status, setStatus] = useState<string>("all");
  const [term, setTerm] = useState("");

  const q = useQuery({
    queryKey: useOrgQueryKey(["bills", status]),
    queryFn: () =>
      jsonFetch<Payload>(
        `/api/v1/orgs/${orgId}/bills${status === "all" ? "" : `?status=${status}`}`,
      ),
  });

  const bills = useMemo(() => q.data?.data ?? [], [q.data]);
  const today = q.data?.today ?? new Date().toISOString().slice(0, 10);

  const shown = useMemo(() => {
    const t = term.trim().toLowerCase();
    if (!t) return bills;
    return bills.filter((b) =>
      `${b.vendorName} ${b.reference} ${b.project?.name ?? ""} ${b.project?.key ?? ""}`
        .toLowerCase()
        .includes(t),
    );
  }, [bills, term]);

  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.isError) return <LoadError onRetry={() => q.refetch()} />;

  const t = q.data?.totals ?? { total: 0, paid: 0, owed: 0, pastDue: 0 };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total">
          <p className="text-2xl font-semibold tabular-nums">{money(t.total)}</p>
        </StatCard>
        <StatCard label="Paid">
          <p className="text-2xl font-semibold tabular-nums">{money(t.paid)}</p>
        </StatCard>
        <StatCard label="Owed">
          <p className="text-2xl font-semibold tabular-nums">{money(t.owed)}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Not yet due</p>
        </StatCard>
        <StatCard label="Past due">
          <p
            className={cn(
              "text-2xl font-semibold tabular-nums",
              t.pastDue > 0 && "text-[var(--status-critical-text,var(--status-critical))]",
            )}
          >
            {money(t.pastDue)}
          </p>
        </StatCard>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setStatus(f.key)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm",
              status === f.key
                ? "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            {f.label}
          </button>
        ))}
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search vendor, reference or job"
          className="ml-auto h-9 w-72"
        />
      </div>

      {shown.length === 0 ? (
        <EmptyState
          illustration={
            <Receipt className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} />
          }
          title={bills.length === 0 ? "No bills yet" : "Nothing matches"}
          description={
            bills.length === 0
              ? "What consultants and suppliers invoice the practice appears here, against the job it belongs to."
              : "No bill matches this filter."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
              <tr>
                <th className="px-4 py-2 font-medium">Bill</th>
                <th className="px-4 py-2 font-medium">Vendor</th>
                <th className="px-4 py-2 font-medium">Job</th>
                <th className="px-4 py-2 font-medium">Issued</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium">Outstanding</th>
                <th className="px-4 py-2 font-medium">Client invoice</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Due</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => {
                const late = isPastDue(b, today);
                const left = outstanding(b);
                return (
                  <tr key={b.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-4 py-2 font-medium">{b.reference}</td>
                    <td className="px-4 py-2">{b.vendorName}</td>
                    <td className="px-4 py-2 text-[var(--text-muted)]">
                      {b.project ? `${b.project.key} · ${b.project.name}` : "—"}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-[var(--text-muted)]">
                      {fmtDate(b.issueDate)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(b.amount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {left > 0 ? money(left) : "—"}
                    </td>
                    <td className="px-4 py-2 text-[var(--text-muted)]">
                      {b.invoice ? `${b.invoice.number} · ${b.invoice.status}` : "No client invoice"}
                    </td>
                    <td className="px-4 py-2">{STATUS[b.status] ?? b.status}</td>
                    <td
                      className={cn(
                        "px-4 py-2 whitespace-nowrap",
                        late
                          ? "text-[var(--status-critical-text,var(--status-critical))]"
                          : "text-[var(--text-muted)]",
                      )}
                    >
                      {dueLabel(b, today, fmtDate2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
