"use client";

/**
 * Static Release Timeline (TIMELINE board type, config.mode === "release-timeline").
 * Deliberately NOT the Gantt: a read-only, presentation-oriented "big picture"
 * snapshot on a month axis, where the user chooses which LEVELS to overlay —
 * Increments (PIs/cycles) as bands, plus Deliverables and Milestones as dated
 * chips. No drag, no per-item editing: it's the screenshot-for-a-stakeholder view.
 * The interactive, day-level, editable scheduler is the Gantt (TimelineView).
 */
import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { CalendarRange, Lock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { cn } from "@/lib/utils";
import type { Cycle } from "@/types/models";

interface ReleaseTimelineViewProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

interface Deliverable {
  id: string;
  code: string;
  title: string;
  baselineDue: string | null;
  status: string;
}
interface Milestone {
  id: string;
  title: string;
  name?: string;
  dueDate?: string | null;
  baselineDate?: string | null;
  projectedDate?: string | null;
  status?: string;
}

const MONTH_W = 104; // px per month column
const LABEL_W = 150;

type LevelKey = "increments" | "deliverables" | "milestones";
const LEVELS: { key: LevelKey; label: string }[] = [
  { key: "increments", label: "Increments" },
  { key: "deliverables", label: "Deliverables" },
  { key: "milestones", label: "Milestones" },
];

function ym(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(d: Date): string {
  return d.toLocaleString("en-US", { month: "short" }) + " '" + String(d.getFullYear()).slice(2);
}
function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

export function ReleaseTimelineView({ orgId, projectId }: ReleaseTimelineViewProps) {
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const cyclesKey = useOrgQueryKey("cycles", projectId);
  const deliverablesKey = useOrgQueryKey("deliverables", projectId);
  const milestonesKey = useOrgQueryKey("milestones", projectId);

  const [cyclesQ, deliverablesQ, milestonesQ] = useQueries({
    queries: [
      { queryKey: cyclesKey, queryFn: () => jsonFetch<Cycle[]>(`${basePath}/cycles`) },
      {
        queryKey: deliverablesKey,
        queryFn: () => jsonFetch<Deliverable[]>(`${basePath}/deliverables`),
      },
      {
        queryKey: milestonesKey,
        queryFn: () => jsonFetch<Milestone[]>(`${basePath}/milestones`),
      },
    ],
  });

  const cycles: Cycle[] = useMemo(() => cyclesQ.data ?? [], [cyclesQ.data]);
  const deliverables: Deliverable[] = useMemo(() => deliverablesQ.data ?? [], [deliverablesQ.data]);
  const milestones: Milestone[] = useMemo(() => milestonesQ.data ?? [], [milestonesQ.data]);

  const [active, setActive] = useState<Set<LevelKey>>(
    () => new Set<LevelKey>(["increments", "deliverables"]),
  );

  const loading = cyclesQ.isLoading || deliverablesQ.isLoading || milestonesQ.isLoading;

  const milestoneDate = (m: Milestone) => m.dueDate ?? m.baselineDate ?? m.projectedDate ?? null;

  // Build the month axis from every dated thing we might show.
  const axis = useMemo(() => {
    const dates: Date[] = [];
    for (const c of cycles) {
      if (c.startDate) dates.push(new Date(c.startDate));
      if (c.endDate) dates.push(new Date(c.endDate));
    }
    for (const d of deliverables) if (d.baselineDue) dates.push(new Date(d.baselineDue));
    for (const m of milestones) {
      const md = milestoneDate(m);
      if (md) dates.push(new Date(md));
    }
    if (dates.length === 0) return null;
    const min = firstOfMonth(new Date(Math.min(...dates.map((d) => d.getTime()))));
    const max = firstOfMonth(new Date(Math.max(...dates.map((d) => d.getTime()))));
    const count = monthsBetween(min, max) + 1;
    const months = Array.from({ length: count }, (_, i) => new Date(min.getFullYear(), min.getMonth() + i, 1));
    const indexOf = (dt: Date) => monthsBetween(min, firstOfMonth(dt));
    return { min, months, indexOf, width: count * MONTH_W };
  }, [cycles, deliverables, milestones]);

  // Group deliverables / milestones by month index.
  const deliverablesByMonth = useMemo(() => {
    const map = new Map<number, Deliverable[]>();
    if (!axis) return map;
    for (const d of deliverables) {
      if (!d.baselineDue) continue;
      const i = axis.indexOf(new Date(d.baselineDue));
      const arr = map.get(i) ?? [];
      arr.push(d);
      map.set(i, arr);
    }
    return map;
  }, [deliverables, axis]);

  const milestonesByMonth = useMemo(() => {
    const map = new Map<number, Milestone[]>();
    if (!axis) return map;
    for (const m of milestones) {
      const md = milestoneDate(m);
      if (!md) continue;
      const i = axis.indexOf(new Date(md));
      const arr = map.get(i) ?? [];
      arr.push(m);
      map.set(i, arr);
    }
    return map;
  }, [milestones, axis]);

  if (loading) return <ReleaseTimelineSkeleton />;

  if (!axis) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={CalendarRange}
          title="Nothing to plot yet"
          description="Add increments (with dates), deliverables, or milestones and they'll appear on this release timeline."
        />
      </div>
    );
  }

  const toggle = (k: LevelKey) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const sortedCycles = [...cycles].sort(
    (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
  );

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2 text-sm">
        <div className="flex items-center gap-2 font-medium text-[var(--text)]">
          <CalendarRange className="size-4 text-[var(--primary)]" /> Release Timeline
        </div>
        <span className="flex items-center gap-1 rounded-full bg-[var(--muted)]/50 px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
          <Lock className="size-3" /> read-only snapshot
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-[var(--text-muted)]">Show:</span>
          {LEVELS.map((lvl) => (
            <label key={lvl.key} className="flex items-center gap-1.5 text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={active.has(lvl.key)}
                onChange={() => toggle(lvl.key)}
                className="accent-[var(--primary)]"
              />
              {lvl.label}
            </label>
          ))}
        </div>
      </div>

      {/* timeline */}
      <div className="flex-1 overflow-auto">
        <div style={{ width: LABEL_W + axis.width }} className="min-w-full">
          {/* month header */}
          <div className="sticky top-0 z-10 flex border-b border-[var(--border)] bg-[var(--surface)]">
            <div
              style={{ width: LABEL_W }}
              className="sticky left-0 z-10 shrink-0 border-r border-[var(--border)] bg-[var(--surface)]"
            />
            {axis.months.map((m) => (
              <div
                key={ym(m)}
                style={{ width: MONTH_W }}
                className={cn(
                  "shrink-0 border-r border-[var(--border)] px-2 py-1.5 text-center text-[11px] text-[var(--text-muted)]",
                  m.getMonth() === 0 && "font-semibold text-[var(--text)]",
                )}
              >
                {monthLabel(m)}
              </div>
            ))}
          </div>

          {/* Increments band */}
          {active.has("increments") && (
            <LevelRow label="Increments">
              <div className="relative" style={{ width: axis.width, height: sortedCycles.length * 30 + 8 }}>
                {sortedCycles.map((c, i) => {
                  const start = axis.indexOf(new Date(c.startDate));
                  const end = axis.indexOf(new Date(c.endDate));
                  const left = start * MONTH_W + 2;
                  const width = Math.max((end - start + 1) * MONTH_W - 4, MONTH_W - 4);
                  return (
                    <div
                      key={c.id}
                      className="absolute flex items-center rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/15 px-2 text-xs font-medium text-[var(--text)]"
                      style={{ left, width, top: i * 30 + 4, height: 24 }}
                      title={`${c.name}`}
                    >
                      <span className="truncate">{c.name}</span>
                    </div>
                  );
                })}
              </div>
            </LevelRow>
          )}

          {/* Deliverables */}
          {active.has("deliverables") && (
            <LevelRow label="Deliverables">
              <MonthChips
                axis={axis}
                byMonth={deliverablesByMonth}
                render={(d: Deliverable) => ({
                  key: d.id,
                  label: d.code,
                  title: `${d.code} — ${d.title}`,
                  done: d.status === "ACCEPTED" || d.status === "SUBMITTED",
                })}
              />
            </LevelRow>
          )}

          {/* Milestones */}
          {active.has("milestones") && (
            <LevelRow label="Milestones">
              <MonthChips
                axis={axis}
                byMonth={milestonesByMonth}
                render={(m: Milestone) => ({
                  key: m.id,
                  label: m.name ?? m.title,
                  title: m.name ?? m.title,
                  done: m.status === "COMPLETED" || m.status === "MET",
                })}
              />
            </LevelRow>
          )}
        </div>
      </div>
    </div>
  );
}

function LevelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex border-b border-[var(--border)]">
      <div
        style={{ width: LABEL_W }}
        className="sticky left-0 z-[5] shrink-0 border-r border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
      >
        {label}
      </div>
      <div className="p-1">{children}</div>
    </div>
  );
}

interface AxisInfo {
  months: Date[];
  indexOf: (d: Date) => number;
  width: number;
}

function MonthChips<T>({
  axis,
  byMonth,
  render,
}: {
  axis: AxisInfo;
  byMonth: Map<number, T[]>;
  render: (item: T) => { key: string; label: string; title: string; done: boolean };
}) {
  return (
    <div className="flex" style={{ width: axis.width }}>
      {axis.months.map((m, i) => (
        <div key={i} style={{ width: MONTH_W }} className="shrink-0 space-y-0.5 px-1">
          {(byMonth.get(i) ?? []).map((item) => {
            const r = render(item);
            return (
              <div
                key={r.key}
                title={r.title}
                className={cn(
                  "truncate rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[10px] text-[var(--text)]",
                  r.done && "opacity-60 line-through",
                )}
              >
                {r.label}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ReleaseTimelineSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] px-4 py-2">
        <Skeleton className="h-6 w-56" />
      </div>
      <div className="flex-1 space-y-3 p-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    </div>
  );
}
