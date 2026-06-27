"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  Flag,
  Gauge,
  Target,
  TrendingUp,
  TrendingDown,
  Minus,
  CalendarClock,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Public shape — the dashboard is scope-aware (project now; org / sub-element
// reuse the same surface later) and audience-aware (PM / Government / Executive,
// wired in the next step). Data is passed in from the server component so this
// stays a pure presentational unit.
// ---------------------------------------------------------------------------

export type DashboardScope =
  | { kind: "org"; orgId: string; orgName: string }
  | {
      kind: "project";
      orgId: string;
      projectId: string;
      projectKey: string;
      projectName: string;
    };

export type AudienceView = "pm" | "government" | "executive";

export type MilestoneStatus = "UPCOMING" | "IN_PROGRESS" | "COMPLETED" | "MISSED";
export type GoalStatus =
  | "PLANNED"
  | "ON_TRACK"
  | "AT_RISK"
  | "OFF_TRACK"
  | "ACHIEVED";

export interface MilestoneLite {
  id: string;
  title: string;
  status: MilestoneStatus;
  dueDate: string; // ISO
}
export interface KpiLite {
  id: string;
  name: string;
  unit: string;
  targetValue: number;
  currentValue: number;
  direction: "UP_GOOD" | "DOWN_GOOD";
}
export interface GoalLite {
  id: string;
  title: string;
  status: GoalStatus;
  progress: number; // 0-100
}

export interface PmDashboardData {
  milestones: MilestoneLite[];
  kpis: KpiLite[];
  goals: GoalLite[];
}

interface PmDashboardProps {
  scope: DashboardScope;
  data: PmDashboardData;
  /** Defaults to "pm"; the audience switcher arrives in the next step. */
  audience?: AudienceView;
}

// ---------------------------------------------------------------------------
// Status helpers — color via the app's status CSS vars, with safe fallbacks.
// ---------------------------------------------------------------------------

const MILESTONE_META: Record<MilestoneStatus, { label: string; color: string }> = {
  COMPLETED: { label: "Completed", color: "var(--status-done, #16a34a)" },
  IN_PROGRESS: { label: "In progress", color: "var(--status-progress, #2563eb)" },
  UPCOMING: { label: "Upcoming", color: "var(--text-muted, #6b7280)" },
  MISSED: { label: "Missed", color: "var(--status-blocked, #dc2626)" },
};

const GOAL_META: Record<GoalStatus, { label: string; color: string }> = {
  ACHIEVED: { label: "Achieved", color: "var(--status-done, #16a34a)" },
  ON_TRACK: { label: "On track", color: "var(--status-done, #16a34a)" },
  AT_RISK: { label: "At risk", color: "var(--status-warn, #d97706)" },
  OFF_TRACK: { label: "Off track", color: "var(--status-blocked, #dc2626)" },
  PLANNED: { label: "Planned", color: "var(--text-muted, #6b7280)" },
};

function isOnTarget(k: KpiLite): boolean {
  return k.direction === "UP_GOOD"
    ? k.currentValue >= k.targetValue
    : k.currentValue <= k.targetValue;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------

export function PmDashboard({ scope, data, audience = "pm" }: PmDashboardProps) {
  const { milestones, kpis, goals } = data;

  const stats = useMemo(() => {
    const slipped = milestones.filter(
      (m) => m.status === "MISSED" || m.status === "IN_PROGRESS",
    ).length;
    const onTarget = kpis.filter(isOnTarget).length;
    const goalsAtRisk = goals.filter(
      (g) => g.status === "AT_RISK" || g.status === "OFF_TRACK",
    ).length;
    return { slipped, onTarget, goalsAtRisk };
  }, [milestones, kpis, goals]);

  const scopeLabel =
    scope.kind === "project" ? scope.projectName : scope.orgName;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-[var(--text)]">
            Program Management
          </h2>
          <p className="text-sm text-[var(--text-muted)]">
            {scopeLabel}
            {scope.kind === "project" ? " — program health at a glance" : " — portfolio roll-up"}
          </p>
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Flag}
          label="Milestones"
          value={milestones.length}
          sub={`${stats.slipped} in progress / slipped`}
        />
        <StatCard
          icon={Gauge}
          label="KPIs on target"
          value={`${stats.onTarget}/${kpis.length}`}
          sub={kpis.length ? `${kpis.length} tracked` : "none tracked"}
        />
        <StatCard
          icon={Target}
          label="Goals"
          value={goals.length}
          sub={`${stats.goalsAtRisk} at risk`}
          accent={stats.goalsAtRisk > 0 ? "var(--status-warn, #d97706)" : undefined}
        />
        <StatCard
          icon={CalendarClock}
          label="Next milestone"
          value={nextMilestoneLabel(milestones)}
          sub="by due date"
        />
      </div>

      {/* Panels */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Schedule — Milestones">
          {milestones.length === 0 ? (
            <EmptyRow label="No milestones yet." />
          ) : (
            <ul className="flex flex-col">
              {milestones.map((m) => {
                const meta = MILESTONE_META[m.status];
                return (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-2.5 last:border-0"
                  >
                    <span className="min-w-0 truncate text-sm text-[var(--text)]">
                      {m.title}
                    </span>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs tabular-nums text-[var(--text-muted)]">
                        {formatDate(m.dueDate)}
                      </span>
                      <StatusPill label={meta.label} color={meta.color} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Key Performance Indicators">
          {kpis.length === 0 ? (
            <EmptyRow label="No KPIs yet." />
          ) : (
            <ul className="flex flex-col">
              {kpis.map((k) => {
                const onTarget = isOnTarget(k);
                const delta = k.currentValue - k.targetValue;
                const DeltaIcon =
                  delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
                return (
                  <li
                    key={k.id}
                    className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-2.5 last:border-0"
                  >
                    <span className="min-w-0 truncate text-sm text-[var(--text)]">
                      {k.name}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-sm font-medium tabular-nums text-[var(--text)]">
                        {formatNumber(k.currentValue)}
                        {k.unit ? ` ${k.unit}` : ""}
                      </span>
                      <span
                        className="inline-flex items-center gap-0.5 text-xs tabular-nums"
                        style={{
                          color: onTarget
                            ? "var(--status-done, #16a34a)"
                            : "var(--status-blocked, #dc2626)",
                        }}
                      >
                        <DeltaIcon className="size-3" aria-hidden />
                        {formatNumber(Math.abs(delta))}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Goals & Objectives" className="lg:col-span-2">
          {goals.length === 0 ? (
            <EmptyRow label="No goals yet." />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {goals.map((g) => {
                const meta = GOAL_META[g.status];
                return (
                  <div
                    key={g.id}
                    className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-[var(--text)]">
                        {g.title}
                      </span>
                      <StatusPill label={meta.label} color={meta.color} />
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.max(0, Math.min(100, g.progress))}%`,
                            backgroundColor: meta.color,
                          }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-[var(--text-muted)]">
                        {g.progress}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {/* Audience marker — the switcher + Government/Executive variants land in
          the next step; for now this surface renders the PM view. */}
      <p className="text-xs text-[var(--text-muted)]">
        Audience view: <span className="font-medium capitalize">{audience}</span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div
        className="text-2xl font-semibold tabular-nums text-[var(--text)]"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-[var(--text-muted)]">{sub}</div>}
    </div>
  );
}

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5",
        className,
      )}
    >
      <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
      {children}
    </section>
  );
}

function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {label}
    </span>
  );
}

function EmptyRow({ label }: { label: string }) {
  return <p className="py-3 text-sm text-[var(--text-muted)]">{label}</p>;
}

function nextMilestoneLabel(milestones: MilestoneLite[]): string {
  const upcoming = milestones
    .filter((m) => m.status !== "COMPLETED")
    .sort((a, b) => +new Date(a.dueDate) - +new Date(b.dueDate))[0];
  if (!upcoming) return "—";
  return formatDate(upcoming.dueDate);
}
