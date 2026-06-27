"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import {
  Flag,
  Gauge,
  Target,
  TrendingUp,
  TrendingDown,
  Minus,
  CalendarClock,
  Briefcase,
  Landmark,
  LineChart,
  Gavel,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Public shape — scope-aware (project now; org / sub-element reuse the same
// surface) and audience-aware (PM / Government / Executive, gated by RBAC).
// Data is passed in from the server component so this stays presentational.
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
  /** Initial audience; the switcher only offers audiences the actor may see. */
  audience?: AudienceView;
}

// Each audience is gated by its own permission bit. PM is the baseline view;
// Government and Executive are progressively narrower (program/contracting
// staff, then leadership) — server-enforced via the same bitmask the rest of
// the app uses, replacing the prototype's client-side substring disclosure.
const AUDIENCES: {
  key: AudienceView;
  label: string;
  perm: bigint;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { key: "pm", label: "PM", perm: Permission.ANALYTICS_READ, icon: Briefcase },
  { key: "government", label: "Government", perm: Permission.REPORT_CREATE, icon: Landmark },
  { key: "executive", label: "Executive", perm: Permission.REPORT_MANAGE, icon: LineChart },
];

// ---------------------------------------------------------------------------

export function PmDashboard({ scope, data, audience: initialAudience }: PmDashboardProps) {
  const { can } = usePermissions();

  const audiences = useMemo(() => {
    const allowed = AUDIENCES.filter((a) => can(a.perm));
    // Fall back to the PM baseline so the surface never renders empty for a
    // project member who reached the feature-gated tab without analytics grants.
    return allowed.length > 0 ? allowed : [AUDIENCES[0]];
  }, [can]);

  const [audience, setAudience] = useState<AudienceView>(() => {
    const want = initialAudience ?? "pm";
    return audiences.some((a) => a.key === want) ? want : audiences[0].key;
  });

  const stats = useMemo(() => computeStats(data), [data]);
  const scopeLabel = scope.kind === "project" ? scope.projectName : scope.orgName;

  const header = AUDIENCE_HEADER[audience];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      {/* Header + audience switcher */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-[var(--text)]">{header.title}</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {scopeLabel} — {header.subtitle}
          </p>
        </div>
        {audiences.length > 1 && (
          <div
            role="tablist"
            aria-label="Audience view"
            className="inline-flex rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-0.5"
          >
            {audiences.map((a) => {
              const active = a.key === audience;
              const Icon = a.icon;
              return (
                <button
                  key={a.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setAudience(a.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[calc(var(--radius)-2px)] px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-[var(--primary)] text-[var(--primary-foreground,#fff)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text)]",
                  )}
                >
                  <Icon className="size-3.5" />
                  {a.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {audience === "pm" && <PmView data={data} stats={stats} />}
      {audience === "government" && <GovernmentView data={data} stats={stats} />}
      {audience === "executive" && <ExecutiveView data={data} stats={stats} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audience views
// ---------------------------------------------------------------------------

function PmView({ data, stats }: ViewProps) {
  return (
    <>
      <StatRow data={data} stats={stats} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MilestonesPanel milestones={data.milestones} />
        <KpisPanel kpis={data.kpis} />
        <GoalsPanel goals={data.goals} className="lg:col-span-2" />
      </div>
    </>
  );
}

function GovernmentView({ data, stats }: ViewProps) {
  return (
    <>
      <Panel title="Program Status — At a Glance">
        <p className="text-sm leading-relaxed text-[var(--text)]">
          The program is in active execution.{" "}
          <strong>{stats.slipped}</strong> milestone
          {stats.slipped === 1 ? " is" : "s are"} in progress or slipped,{" "}
          <strong>{stats.goalsAtRisk}</strong> goal
          {stats.goalsAtRisk === 1 ? " is" : "s are"} flagged at risk, and{" "}
          <strong>
            {stats.onTarget}/{data.kpis.length}
          </strong>{" "}
          KPIs are on target. Items awaiting a government decision are
          consolidated under <em>Decisions Required</em>.
        </p>
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MilestonesPanel milestones={data.milestones} title="Schedule & Deliverables" />
        <KpisPanel kpis={data.kpis} title="Performance vs. Target" />
        <Panel title="Decisions Required" className="lg:col-span-2">
          <div className="flex items-center gap-2 py-2 text-sm text-[var(--text-muted)]">
            <Gavel className="size-4 shrink-0" />
            <span>
              No items currently awaiting government action. Blockers escalated
              to the customer surface here.
            </span>
          </div>
        </Panel>
      </div>
    </>
  );
}

function ExecutiveView({ data, stats }: ViewProps) {
  return (
    <>
      <StatRow data={data} stats={stats} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GoalsPanel goals={data.goals} title="Strategic Goals" />
        <KpisPanel kpis={data.kpis} title="Headline KPIs" />
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Executive summary — program-health and outcome trajectory. No
        task-level or government-specific detail.
      </p>
    </>
  );
}

interface ViewProps {
  data: PmDashboardData;
  stats: ReturnType<typeof computeStats>;
}

const AUDIENCE_HEADER: Record<AudienceView, { title: string; subtitle: string }> = {
  pm: { title: "Program Management", subtitle: "program health at a glance" },
  government: {
    title: "Government Customer View",
    subtitle: "for the COR & government stakeholders",
  },
  executive: { title: "Executive View", subtitle: "program-health summary" },
};

// ---------------------------------------------------------------------------
// Shared panels
// ---------------------------------------------------------------------------

function StatRow({ data, stats }: ViewProps) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard
        icon={Flag}
        label="Milestones"
        value={data.milestones.length}
        sub={`${stats.slipped} in progress / slipped`}
      />
      <StatCard
        icon={Gauge}
        label="KPIs on target"
        value={`${stats.onTarget}/${data.kpis.length}`}
        sub={data.kpis.length ? `${data.kpis.length} tracked` : "none tracked"}
      />
      <StatCard
        icon={Target}
        label="Goals"
        value={data.goals.length}
        sub={`${stats.goalsAtRisk} at risk`}
        accent={stats.goalsAtRisk > 0 ? "var(--status-warn, #d97706)" : undefined}
      />
      <StatCard
        icon={CalendarClock}
        label="Next milestone"
        value={nextMilestoneLabel(data.milestones)}
        sub="by due date"
      />
    </div>
  );
}

function MilestonesPanel({
  milestones,
  title = "Schedule — Milestones",
}: {
  milestones: MilestoneLite[];
  title?: string;
}) {
  return (
    <Panel title={title}>
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
                <span className="min-w-0 truncate text-sm text-[var(--text)]">{m.title}</span>
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
  );
}

function KpisPanel({ kpis, title = "Key Performance Indicators" }: { kpis: KpiLite[]; title?: string }) {
  return (
    <Panel title={title}>
      {kpis.length === 0 ? (
        <EmptyRow label="No KPIs yet." />
      ) : (
        <ul className="flex flex-col">
          {kpis.map((k) => {
            const onTarget = isOnTarget(k);
            const delta = k.currentValue - k.targetValue;
            const DeltaIcon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
            return (
              <li
                key={k.id}
                className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-2.5 last:border-0"
              >
                <span className="min-w-0 truncate text-sm text-[var(--text)]">{k.name}</span>
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
  );
}

function GoalsPanel({
  goals,
  title = "Goals & Objectives",
  className,
}: {
  goals: GoalLite[];
  title?: string;
  className?: string;
}) {
  return (
    <Panel title={title} className={className}>
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
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces + helpers
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

function computeStats(data: PmDashboardData) {
  const slipped = data.milestones.filter(
    (m) => m.status === "MISSED" || m.status === "IN_PROGRESS",
  ).length;
  const onTarget = data.kpis.filter(isOnTarget).length;
  const goalsAtRisk = data.goals.filter(
    (g) => g.status === "AT_RISK" || g.status === "OFF_TRACK",
  ).length;
  return { slipped, onTarget, goalsAtRisk };
}

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

function nextMilestoneLabel(milestones: MilestoneLite[]): string {
  const upcoming = milestones
    .filter((m) => m.status !== "COMPLETED")
    .sort((a, b) => +new Date(a.dueDate) - +new Date(b.dueDate))[0];
  return upcoming ? formatDate(upcoming.dueDate) : "—";
}

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
