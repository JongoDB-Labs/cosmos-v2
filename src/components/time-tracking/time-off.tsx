"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { CalendarOff } from "lucide-react";

/**
 * Asking to be away, and deciding on somebody else's ask.
 *
 * Both halves live on one screen because they are the same object seen from two
 * sides, and a supervisor who had to visit a second page to answer would leave
 * people waiting. The queue only appears when something is actually waiting on
 * this person, so it costs nothing to everyone else.
 */

type Request = {
  id: string;
  userId: string;
  kind: Kind;
  status: Status;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  hours: number;
  note: string | null;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
};

type Kind =
  | "VACATION"
  | "SICK"
  | "HOLIDAY"
  | "UNPAID"
  | "PARENTAL"
  | "BEREAVEMENT"
  | "OTHER";
type Status = "PENDING" | "APPROVED" | "DENIED" | "WITHDRAWN";

type Person = { userId: string; displayName: string | null; isSelf: boolean };

const KIND: Record<Kind, string> = {
  VACATION: "Holiday",
  SICK: "Sick",
  HOLIDAY: "Office closed",
  UNPAID: "Unpaid",
  PARENTAL: "Parental",
  BEREAVEMENT: "Bereavement",
  OTHER: "Other",
};

const STATUS: Record<Status, { label: string; tone: string }> = {
  PENDING: { label: "Waiting", tone: "bg-amber-500" },
  APPROVED: { label: "Approved", tone: "bg-emerald-500" },
  DENIED: { label: "Declined", tone: "bg-red-500" },
  WITHDRAWN: { label: "Withdrawn", tone: "bg-[var(--text-muted)]" },
};

const fmt = (iso: string) =>
  new Date(`${iso}T00:00:00.000Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const span = (r: Request) =>
  r.startDate === r.endDate ? fmt(r.startDate) : `${fmt(r.startDate)} – ${fmt(r.endDate)}`;

const today = () => new Date().toISOString().slice(0, 10);

function Pill({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={cn("h-2 w-2 rounded-full", s.tone)} />
      {s.label}
    </span>
  );
}

export function TimeOff({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const mineKey = useOrgQueryKey(["time-off", "mine"]);
  const teamKey = useOrgQueryKey(["time-off", "team"]);

  const mine = useQuery({
    queryKey: mineKey,
    queryFn: () => jsonFetch<Request[]>(`/api/v1/orgs/${orgId}/time-off`),
  });
  const team = useQuery({
    queryKey: teamKey,
    queryFn: () =>
      jsonFetch<Request[]>(`/api/v1/orgs/${orgId}/time-off?scope=team&status=PENDING`),
  });
  const people = useQuery({
    queryKey: useOrgQueryKey(["time-people"]),
    queryFn: () => jsonFetch<Person[]>(`/api/v1/orgs/${orgId}/time-entries/people`),
  });

  const nameOf = useMemo(() => {
    const byId = new Map((people.data ?? []).map((p) => [p.userId, p.displayName]));
    return (id: string) => byId.get(id) || "Someone";
  }, [people.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: mineKey });
    void qc.invalidateQueries({ queryKey: teamKey });
  };

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("VACATION");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [hoursPerDay, setHoursPerDay] = useState("8");
  const [note, setNote] = useState("");

  const ask = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/orgs/${orgId}/time-off`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          startDate,
          endDate,
          hoursPerDay: Number(hoursPerDay) || 8,
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Could not file that");
      return res.json();
    },
    onSuccess: () => {
      setOpen(false);
      setNote("");
      refresh();
    },
  });

  const decide = useMutation({
    mutationFn: async (v: { id: string; action: "approve" | "deny" | "withdraw" }) => {
      const res = await fetch(`/api/v1/orgs/${orgId}/time-off/${v.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: v.action }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Could not do that");
      return res.json();
    },
    onSuccess: refresh,
  });

  if (mine.isLoading) return <Skeleton className="h-64 w-full" />;
  if (mine.isError) return <LoadError onRetry={() => mine.refetch()} />;

  const rows = mine.data ?? [];
  // Somebody else's ask, still waiting. My own is already in the list below,
  // and approving your own is refused by the server anyway.
  const waiting = (team.data ?? []).filter((r) => !rows.some((m) => m.id === r.id));

  const badRange = endDate < startDate;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold">Your time off</h2>
          <Button size="sm" className="ml-auto" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "Request time off"}
          </Button>
        </div>

        {open && (
          <div className="grid gap-4 rounded-lg border border-[var(--border)] p-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="to-kind">Reason</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
                <SelectTrigger id="to-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(KIND) as Kind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to-from">First day</Label>
              <Input
                id="to-from"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (endDate < e.target.value) setEndDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to-to">Last day</Label>
              <Input
                id="to-to"
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to-hpd">Hours a day</Label>
              <Input
                id="to-hpd"
                type="number"
                min="0.5"
                max="24"
                step="0.5"
                value={hoursPerDay}
                onChange={(e) => setHoursPerDay(e.target.value)}
              />
              <p className="text-xs text-[var(--text-muted)]">
                Weekends are not counted.
              </p>
            </div>
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
              <Label htmlFor="to-note">Note</Label>
              <Textarea
                id="to-note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="flex items-end gap-3 sm:col-span-2 lg:col-span-5">
              <Button onClick={() => ask.mutate()} disabled={ask.isPending || badRange}>
                {ask.isPending ? "Sending…" : "Send request"}
              </Button>
              {badRange && (
                <p className="text-sm text-red-500">
                  The last day cannot fall before the first.
                </p>
              )}
              {ask.isError && (
                <p className="text-sm text-red-500">{(ask.error as Error).message}</p>
              )}
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <EmptyState
            illustration={
              <CalendarOff
                className="mx-auto h-12 w-12 text-[var(--text-muted)]"
                strokeWidth={1.5}
              />
            }
            title="No time off booked"
            description="Requests you send appear here with where they have got to."
          />
        ) : (
          <Table
            rows={rows}
            trailing={(r) =>
              r.status === "PENDING" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => decide.mutate({ id: r.id, action: "withdraw" })}
                  disabled={decide.isPending}
                >
                  Withdraw
                </Button>
              ) : null
            }
          />
        )}
      </section>

      {waiting.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">
            Waiting on you{" "}
            <span className="font-normal text-[var(--text-muted)]">({waiting.length})</span>
          </h2>
          <Table
            rows={waiting}
            who={nameOf}
            trailing={(r) => (
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  onClick={() => decide.mutate({ id: r.id, action: "approve" })}
                  disabled={decide.isPending}
                >
                  Approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => decide.mutate({ id: r.id, action: "deny" })}
                  disabled={decide.isPending}
                >
                  Decline
                </Button>
              </div>
            )}
          />
        </section>
      )}

      {decide.isError && (
        <p className="text-sm text-red-500">{(decide.error as Error).message}</p>
      )}
    </div>
  );
}

function Table({
  rows,
  who,
  trailing,
}: {
  rows: Request[];
  who?: (id: string) => string;
  trailing: (r: Request) => React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
      <table className="w-full text-sm">
        <thead className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
          <tr>
            {who && <th className="px-4 py-2 font-medium">Who</th>}
            <th className="px-4 py-2 font-medium">When</th>
            <th className="px-4 py-2 font-medium">Reason</th>
            <th className="px-4 py-2 text-right font-medium">Hours</th>
            {!who && <th className="px-4 py-2 font-medium">Status</th>}
            <th className="px-4 py-2 font-medium">Note</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
              {who && <td className="px-4 py-2">{who(r.userId)}</td>}
              <td className="px-4 py-2 whitespace-nowrap">{span(r)}</td>
              <td className="px-4 py-2">{KIND[r.kind]}</td>
              <td className="px-4 py-2 text-right tabular-nums">{r.hours}</td>
              {!who && (
                <td className="px-4 py-2">
                  <Pill status={r.status} />
                </td>
              )}
              <td className="px-4 py-2 text-[var(--text-muted)]">{r.note || "—"}</td>
              <td className="px-4 py-2 text-right">{trailing(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
