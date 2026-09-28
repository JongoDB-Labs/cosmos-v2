"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey, useOrgSlug } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * A year of your own pay periods.
 *
 * Every period gets a row, including the ones holding no timesheet — a list of
 * only the sheets that exist cannot show a week you forgot, which is the main
 * thing somebody opens this looking for.
 */

type PeriodRow = {
  start: string;
  end: string;
  status: "OPEN" | "SUBMITTED" | "LABOR_APPROVED" | "APPROVED" | "REJECTED" | "LOCKED";
  hours: number;
  submittedAt: string | null;
  lastEditedAt: string | null;
};

const STATUS: Record<PeriodRow["status"], { label: string; tone: string }> = {
  OPEN: { label: "Not submitted", tone: "bg-amber-500" },
  SUBMITTED: { label: "Submitted", tone: "bg-blue-500" },
  LABOR_APPROVED: { label: "Part approved", tone: "bg-blue-500" },
  APPROVED: { label: "Approved", tone: "bg-emerald-500" },
  REJECTED: { label: "Returned", tone: "bg-red-500" },
  LOCKED: { label: "Locked", tone: "bg-[var(--text-muted)]" },
};

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00.000Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

const fmtEdited = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : "—";

export function PastTimesheets({ orgId }: { orgId: string }) {
  const orgSlug = useOrgSlug();
  const [year, setYear] = useState(() => new Date().getUTCFullYear());

  const q = useQuery({
    queryKey: useOrgQueryKey(["timesheet-periods", year]),
    queryFn: () =>
      jsonFetch<PeriodRow[]>(`/api/v1/orgs/${orgId}/timesheets/periods?year=${year}`),
  });

  const rows = q.data ?? [];
  const totals = useMemo(
    () => ({
      hours: rows.reduce((a, r) => a + r.hours, 0),
      submitted: rows.filter((r) => r.status !== "OPEN").length,
      worked: rows.filter((r) => r.hours > 0).length,
    }),
    [rows],
  );

  // A period that has not happened yet is not a period you failed to submit.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" onClick={() => setYear((y) => y - 1)} aria-label="Previous year">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-16 text-center text-lg font-semibold tabular-nums">{year}</span>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setYear((y) => y + 1)}
          disabled={year >= new Date().getUTCFullYear()}
          aria-label="Next year"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="ml-2 text-sm text-[var(--text-muted)]">
          {totals.worked} period{totals.worked === 1 ? "" : "s"} with hours ·{" "}
          {totals.hours.toLocaleString(undefined, { maximumFractionDigits: 2 })} hours ·{" "}
          {totals.submitted} submitted
        </span>
        <Link href={`/${orgSlug}/time-tracking`} className="ml-auto text-sm underline">
          Back to this week
        </Link>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : q.isError ? (
        <LoadError title="Couldn't load your timesheets" onRetry={() => q.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-[var(--text-muted)]">
                  <th className="px-4 py-2">Period</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Hours</th>
                  <th className="px-4 py-2">Last edited</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const future = r.start > today;
                  return (
                    <tr key={r.start} className="border-t border-[var(--border)]">
                      <td className="px-4 py-2 tabular-nums">
                        {fmtDay(r.start)} – {fmtDay(r.end)}
                      </td>
                      <td className="px-4 py-2">
                        {future ? (
                          <span className="text-[var(--text-muted)]">Not started</span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <span className={cn("inline-block size-2 rounded-full", STATUS[r.status].tone)} />
                            {STATUS[r.status].label}
                          </span>
                        )}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2 text-right tabular-nums",
                          r.hours === 0 && "text-[var(--text-muted)]",
                        )}
                      >
                        {r.hours.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-4 py-2 text-[var(--text-muted)]">{fmtEdited(r.lastEditedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
