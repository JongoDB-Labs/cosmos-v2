"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Time-off balances: requested, approved, used and remaining.
 *
 * Everyone sees their own. The table of other people appears only when the
 * server returned other people — it decides who that is (yourself, your
 * reports, or everyone with org-wide time access), so this component never
 * has to second-guess it. Allowance editing appears only for someone the
 * server says may set allowances.
 */

type Row = {
  userId: string;
  displayName: string | null;
  isSelf: boolean;
  requested: number;
  approved: number;
  used: number;
  allowance: number | null;
  allowanceSource: "person" | "org" | null;
  remaining: number | null;
};

type Summary = {
  year: number;
  countedKinds: string[];
  defaultAllowance: number | null;
  canManage: boolean;
  rows: Row[];
};

const KIND_LABEL: Record<string, string> = {
  VACATION: "holiday",
  SICK: "sick leave",
  HOLIDAY: "office closures",
  UNPAID: "unpaid leave",
  PARENTAL: "parental leave",
  BEREAVEMENT: "bereavement leave",
  OTHER: "other leave",
};

const h = (n: number | null) => (n === null ? "—" : `${Number.isInteger(n) ? n : n.toFixed(1)} h`);

export function TimeOffBalances({ orgId }: { orgId: string }) {
  const [year, setYear] = useState(() => new Date().getUTCFullYear());
  const { data, isLoading, isError } = useQuery({
    queryKey: useOrgQueryKey("time-off-summary", year),
    queryFn: () => jsonFetch<Summary>(`/api/v1/orgs/${orgId}/time-off/summary?year=${year}`),
  });
  const save = useOrgMutation({
    mutationFn: (body: { userId?: string; year?: number; hours: number | null }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/time-off/allowances`, { method: "PUT", body: JSON.stringify(body) }),
    invalidate: [["time-off-summary"]],
    onError: (e) => notifyError(e, "Couldn't change the allowance."),
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  // The requests below still work without balances; don't take the page down.
  if (isError || !data) return null;

  const me = data.rows.find((r) => r.isSelf);
  const others = data.rows.filter((r) => !r.isSelf);
  const counts = data.countedKinds.map((k) => KIND_LABEL[k] ?? k.toLowerCase()).join(", ");

  return (
    <section className="space-y-4" aria-label="Time-off balances">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Balance</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Previous year" onClick={() => setYear((y) => y - 1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-12 text-center text-sm font-medium tabular-nums">{data.year}</span>
          <Button variant="ghost" size="icon" aria-label="Next year" onClick={() => setYear((y) => y + 1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <span className="text-xs text-[var(--text-muted)]">Counts {counts}.</span>
      </div>

      {me && (
        <dl className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--border)] p-4 sm:grid-cols-5" data-testid="my-balance">
          <Figure label="Allowance" value={h(me.allowance)} />
          <Figure label="Used" value={h(me.used)} />
          <Figure label="Approved, to come" value={h(me.approved)} />
          <Figure label="Waiting for a decision" value={h(me.requested)} />
          <Figure
            label="Remaining"
            value={me.allowance === null ? "No allowance set" : h(me.remaining)}
            tone={me.remaining !== null && me.remaining < 0 ? "text-red-600 dark:text-red-400" : undefined}
          />
        </dl>
      )}

      {data.canManage && (
        <DefaultAllowance
          key={`${data.defaultAllowance}`}
          value={data.defaultAllowance}
          pending={save.isPending}
          onSave={(hours) => save.mutate({ hours })}
        />
      )}

      {others.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <caption className="sr-only">Everyone&apos;s time off in {data.year}</caption>
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)]">
                <th className="px-3 py-2 font-medium">Person</th>
                <th className="px-3 py-2 text-right font-medium">Allowance</th>
                <th className="px-3 py-2 text-right font-medium">Waiting</th>
                <th className="px-3 py-2 text-right font-medium">Approved, to come</th>
                <th className="px-3 py-2 text-right font-medium">Used</th>
                <th className="px-3 py-2 text-right font-medium">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.userId} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-3 py-2">
                    {r.displayName ?? "Someone"}
                    {r.isSelf && <span className="ml-1 text-xs text-[var(--text-muted)]">(you)</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {data.canManage ? (
                      <PersonAllowance
                        key={`${r.userId}:${r.allowance}:${r.allowanceSource}`}
                        row={r}
                        pending={save.isPending}
                        onSave={(hours) => save.mutate({ userId: r.userId, year: data.year, hours })}
                      />
                    ) : (
                      h(r.allowance)
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{h(r.requested)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{h(r.approved)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{h(r.used)}</td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      r.remaining !== null && r.remaining < 0 && "text-red-600 dark:text-red-400",
                    )}
                  >
                    {h(r.remaining)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className={cn("text-sm font-medium tabular-nums", tone)}>{value}</dd>
    </div>
  );
}

/** Empty = no allowance. */
const parseHours = (s: string): number | null | undefined => {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 2000 ? n : undefined;
};

function DefaultAllowance({
  value,
  pending,
  onSave,
}: {
  value: number | null;
  pending: boolean;
  onSave: (hours: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const parsed = parseHours(draft);
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <div className="space-y-1">
        <label htmlFor="default-allowance" className="block">
          Default yearly allowance (hours)
        </label>
        <Input
          id="default-allowance"
          className="w-32"
          inputMode="decimal"
          value={draft}
          placeholder="None"
          onChange={(e) => setDraft(e.target.value)}
          disabled={pending}
        />
      </div>
      <Button size="sm" disabled={pending || parsed === undefined || parsed === value} onClick={() => onSave(parsed ?? null)}>
        Save
      </Button>
      <span className="text-xs text-[var(--text-muted)]">Applies to anyone without their own figure for the year.</span>
    </div>
  );
}

function PersonAllowance({
  row,
  pending,
  onSave,
}: {
  row: Row;
  pending: boolean;
  onSave: (hours: number | null) => void;
}) {
  const own = row.allowanceSource === "person" ? row.allowance : null;
  const [draft, setDraft] = useState(own === null ? "" : String(own));
  const commit = () => {
    const parsed = parseHours(draft);
    if (parsed === undefined || parsed === own) return;
    onSave(parsed);
  };
  return (
    <Input
      aria-label={`Allowance for ${row.displayName ?? "this person"}`}
      className="ml-auto h-8 w-24 text-right"
      inputMode="decimal"
      value={draft}
      // The default shows through as the placeholder: empty means "use it".
      placeholder={row.allowanceSource === "org" && row.allowance !== null ? `${row.allowance} (default)` : "None"}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      disabled={pending}
    />
  );
}
