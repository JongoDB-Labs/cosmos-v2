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
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueries } from "@tanstack/react-query";
import { CalendarRange, Lock, Eye, ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey, useOrgSlug } from "@/lib/query/keys";
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

export function ReleaseTimelineView({ orgId, projectId, projectKey }: ReleaseTimelineViewProps) {
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const router = useRouter();
  // Every plotted item links to its own editable surface elsewhere in the app so
  // the Release Timeline is no longer a dead-end snapshot: click (or right-click →
  // Open) a deliverable/milestone/increment and you land on the SAME detail/edit
  // surface you'd reach from any other view (COSMOS-45). Deliverables & milestones
  // deep-link straight to their detail drawer via `?open=<id>`; an increment opens
  // the cycles workspace where it's managed.
  const orgSlug = useOrgSlug();
  const projectBase = `/${orgSlug}/projects/${projectKey}`;
  const deliverableHref = (id: string) =>
    `${projectBase}/pm-dashboard/deliverables?open=${id}`;
  const milestoneHref = (id: string) => `${projectBase}/milestones?open=${id}`;
  const cyclesHref = `${projectBase}/cycles`;
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

  const milestoneDate = (m: Milestone) => m.dueDate ?? null;

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
                      className="group/action absolute"
                      style={{ left, width, top: i * 30 + 4, height: 24 }}
                    >
                      <ActionMenu
                        groups={openGroups(router, cyclesHref)}
                        triggerLabel={`Actions for ${c.name}`}
                        triggerClassName="absolute right-0.5 top-1/2 -translate-y-1/2"
                      >
                        <Link
                          href={cyclesHref}
                          title={c.name}
                          className="flex h-6 w-full items-center rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/15 px-2 pr-5 text-xs font-medium text-[var(--text)] transition-colors hover:border-[var(--primary)] hover:bg-[var(--primary)]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                        >
                          <span className="truncate">{c.name}</span>
                        </Link>
                      </ActionMenu>
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
                router={router}
                render={(d: Deliverable) => ({
                  key: d.id,
                  label: d.code,
                  title: `${d.code} — ${d.title}`,
                  done: d.status === "ACCEPTED" || d.status === "SUBMITTED",
                  href: deliverableHref(d.id),
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
                router={router}
                render={(m: Milestone) => ({
                  key: m.id,
                  label: m.name ?? m.title,
                  title: m.name ?? m.title,
                  done: m.status === "COMPLETED" || m.status === "MET",
                  href: milestoneHref(m.id),
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

/** Right-click / ⋯ menu shared by every plotted item: Open (in place) or Open in
 *  a new tab. Mirrors the context-menu affordance the other board views expose,
 *  so the Release Timeline behaves consistently (COSMOS-45). */
function openGroups(
  router: ReturnType<typeof useRouter>,
  href: string,
): ActionMenuGroup[] {
  return [
    {
      items: [
        { label: "Open", icon: Eye, onClick: () => router.push(href) },
        {
          label: "Open in new tab",
          icon: ExternalLink,
          onClick: () => window.open(href, "_blank", "noopener,noreferrer"),
        },
      ],
    },
  ];
}

/** A single clickable chip on the Release Timeline. The label is a real link to
 *  the item's editable surface (so middle-/⌘-click open a new tab and the ref is
 *  keyboard-navigable), wrapped in the shared ActionMenu for right-click actions. */
function TimelineChip({
  router,
  href,
  label,
  title,
  done,
}: {
  router: ReturnType<typeof useRouter>;
  href: string;
  label: string;
  title: string;
  done: boolean;
}) {
  return (
    <div className="group/action relative">
      <ActionMenu
        groups={openGroups(router, href)}
        triggerLabel={`Actions for ${label}`}
        triggerClassName="absolute right-0.5 top-1/2 -translate-y-1/2"
      >
        <Link
          href={href}
          title={title}
          className={cn(
            "block truncate rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 pr-5 text-[10px] text-[var(--text)] transition-colors hover:border-[var(--primary)] hover:bg-[var(--muted)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
            done && "opacity-60 line-through",
          )}
        >
          {label}
        </Link>
      </ActionMenu>
    </div>
  );
}

function MonthChips<T>({
  axis,
  byMonth,
  router,
  render,
}: {
  axis: AxisInfo;
  byMonth: Map<number, T[]>;
  router: ReturnType<typeof useRouter>;
  render: (item: T) => {
    key: string;
    label: string;
    title: string;
    done: boolean;
    href: string;
  };
}) {
  return (
    <div className="flex" style={{ width: axis.width }}>
      {axis.months.map((m, i) => (
        <div key={i} style={{ width: MONTH_W }} className="shrink-0 space-y-0.5 px-1">
          {(byMonth.get(i) ?? []).map((item) => {
            const r = render(item);
            return (
              <TimelineChip
                key={r.key}
                router={router}
                href={r.href}
                label={r.label}
                title={r.title}
                done={r.done}
              />
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
