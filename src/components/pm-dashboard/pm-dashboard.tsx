"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import {
  Flag,
  Gauge,
  ShieldAlert,
  Ban,
  TrendingUp,
  TrendingDown,
  Minus,
  Briefcase,
  Landmark,
  LineChart,
  Gavel,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Public shape — scope-aware (project now; org / sub-element reuse the surface)
// and audience-aware (PM / Government / Executive, RBAC-gated). Presentational:
// data is fetched in the server component and passed in.
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
export type GoalStatus = "PLANNED" | "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "ACHIEVED";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type DeliverableStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "IN_GOVT_REVIEW"
  | "ACCEPTED"
  | "REJECTED";
export type BlockerType = "INTERNAL" | "EXTERNAL_GOVERNMENT" | "EXTERNAL_VENDOR";

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
  progress: number;
}
export interface RiskLite {
  id: string;
  code: string;
  title: string;
  level: RiskLevel;
  status: "OPEN" | "MONITORING" | "MITIGATING" | "MITIGATED" | "CLOSED" | "ESCALATED";
  score: number;
  escalate: boolean;
}
export interface DeliverableLite {
  id: string;
  code: string;
  title: string;
  status: DeliverableStatus;
  clin: string | null;
  baselineDue: string | null; // ISO
}
export interface BlockerLite {
  id: string;
  code: string;
  title: string;
  type: BlockerType;
  status: "OPEN" | "RESOLVED";
  whatUnblocks: string | null;
  escalate: boolean;
  customerNotified: boolean;
}

export interface PmDashboardData {
  milestones: MilestoneLite[];
  kpis: KpiLite[];
  goals: GoalLite[];
  risks: RiskLite[];
  deliverables: DeliverableLite[];
  blockers: BlockerLite[];
}

interface PmDashboardProps {
  scope: DashboardScope;
  data: PmDashboardData;
  audience?: AudienceView;
}

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
        <RisksPanel risks={data.risks} />
        <BlockersPanel blockers={data.blockers} />
        <DeliverablesPanel deliverables={data.deliverables} />
        <GoalsPanel goals={data.goals} />
      </div>
    </>
  );
}

function GovernmentView({ data, stats }: ViewProps) {
  const govDecisions = data.blockers.filter((b) => b.type === "EXTERNAL_GOVERNMENT");
  return (
    <>
      <Panel title="Program Status — At a Glance">
        <p className="text-sm leading-relaxed text-[var(--text)]">
          The program is in active execution. <strong>{stats.slipped}</strong> milestone
          {stats.slipped === 1 ? " is" : "s are"} in progress or slipped,{" "}
          <strong>{stats.risksElevated}</strong> high/critical risk
          {stats.risksElevated === 1 ? " is" : "s are"} open, and{" "}
          <strong>
            {stats.onTarget}/{data.kpis.length}
          </strong>{" "}
          KPIs are on target. <strong>{govDecisions.length}</strong> item
          {govDecisions.length === 1 ? "" : "s"} await a government decision (below).
        </p>
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MilestonesPanel milestones={data.milestones} title="Schedule" />
        <DeliverablesPanel deliverables={data.deliverables} title="Contract Deliverables (CDRLs)" />
        <KpisPanel kpis={data.kpis} title="Performance vs. Target" />
        <RisksPanel
          risks={data.risks.filter((r) => r.escalate)}
          title="Risks — Customer Awareness"
          emptyLabel="No risks flagged for customer awareness."
        />
        <DecisionsRequiredPanel blockers={govDecisions} className="lg:col-span-2" />
      </div>
    </>
  );
}

function ExecutiveView({ data, stats }: ViewProps) {
  const flags = data.risks.filter((r) => r.level === "CRITICAL" || r.level === "HIGH");
  return (
    <>
      <StatRow data={data} stats={stats} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RisksPanel risks={flags} title="Risk Flags" emptyLabel="No high or critical risks." />
        <GoalsPanel goals={data.goals} title="Strategic Goals" />
        <KpisPanel kpis={data.kpis} title="Headline KPIs" className="lg:col-span-2" />
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Executive summary — program-health and outcome trajectory. No task-level or
        government-specific detail.
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
// Panels
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
        icon={ShieldAlert}
        label="Open risks"
        value={data.risks.length}
        sub={`${stats.risksElevated} high / critical`}
        accent={stats.risksElevated > 0 ? "var(--status-warn, #d97706)" : undefined}
      />
      <StatCard
        icon={Ban}
        label="Open blockers"
        value={data.blockers.length}
        sub={`${stats.blockersEscalated} escalated`}
        accent={stats.blockersEscalated > 0 ? "var(--status-blocked, #dc2626)" : undefined}
      />
      <StatCard
        icon={Gauge}
        label="KPIs on target"
        value={`${stats.onTarget}/${data.kpis.length}`}
        sub={data.kpis.length ? `${data.kpis.length} tracked` : "none tracked"}
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
              <Row key={m.id} title={m.title}>
                <span className="text-xs tabular-nums text-[var(--text-muted)]">
                  {formatDate(m.dueDate)}
                </span>
                <StatusPill label={meta.label} color={meta.color} />
              </Row>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function KpisPanel({
  kpis,
  title = "Key Performance Indicators",
  className,
}: {
  kpis: KpiLite[];
  title?: string;
  className?: string;
}) {
  return (
    <Panel title={title} className={className}>
      {kpis.length === 0 ? (
        <EmptyRow label="No KPIs yet." />
      ) : (
        <ul className="flex flex-col">
          {kpis.map((k) => {
            const onTarget = isOnTarget(k);
            const delta = k.currentValue - k.targetValue;
            const DeltaIcon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
            return (
              <Row key={k.id} title={k.name}>
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
              </Row>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function RisksPanel({
  risks,
  title = "Risk Register",
  emptyLabel = "No open risks.",
}: {
  risks: RiskLite[];
  title?: string;
  emptyLabel?: string;
}) {
  return (
    <Panel title={title}>
      {risks.length === 0 ? (
        <EmptyRow label={emptyLabel} />
      ) : (
        <ul className="flex flex-col">
          {risks.map((r) => {
            const meta = RISK_META[r.level];
            return (
              <Row key={r.id} title={r.title} code={r.code}>
                {r.escalate && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--status-blocked,#dc2626)]">
                    Escalated
                  </span>
                )}
                <span className="text-xs tabular-nums text-[var(--text-muted)]">
                  score {r.score}
                </span>
                <StatusPill label={meta.label} color={meta.color} />
              </Row>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function DeliverablesPanel({
  deliverables,
  title = "Deliverables",
}: {
  deliverables: DeliverableLite[];
  title?: string;
}) {
  return (
    <Panel title={title}>
      {deliverables.length === 0 ? (
        <EmptyRow label="No deliverables yet." />
      ) : (
        <ul className="flex flex-col">
          {deliverables.map((x) => {
            const meta = DELIVERABLE_META[x.status];
            return (
              <Row key={x.id} title={x.title} code={x.clin ? `CLIN ${x.clin}` : x.code}>
                {x.baselineDue && (
                  <span className="text-xs tabular-nums text-[var(--text-muted)]">
                    {formatDate(x.baselineDue)}
                  </span>
                )}
                <StatusPill label={meta.label} color={meta.color} />
              </Row>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function BlockersPanel({ blockers }: { blockers: BlockerLite[] }) {
  return (
    <Panel title="Open Blockers">
      {blockers.length === 0 ? (
        <EmptyRow label="No open blockers." />
      ) : (
        <ul className="flex flex-col">
          {blockers.map((b) => {
            const meta = BLOCKER_META[b.type];
            return (
              <Row key={b.id} title={b.title} code={b.code}>
                {b.escalate && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--status-blocked,#dc2626)]">
                    Escalated
                  </span>
                )}
                <StatusPill label={meta.label} color={meta.color} />
              </Row>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function DecisionsRequiredPanel({
  blockers,
  className,
}: {
  blockers: BlockerLite[];
  className?: string;
}) {
  return (
    <Panel title="Decisions Required" className={className}>
      {blockers.length === 0 ? (
        <div className="flex items-center gap-2 py-2 text-sm text-[var(--text-muted)]">
          <Gavel className="size-4 shrink-0" />
          <span>No items currently awaiting government action.</span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {blockers.map((b) => (
            <li
              key={b.id}
              className="flex flex-col gap-1 rounded-[var(--radius)] border border-[var(--border)] p-3"
            >
              <div className="flex items-center gap-2">
                <Gavel className="size-3.5 shrink-0 text-[var(--status-warn,#d97706)]" />
                <span className="text-sm font-medium text-[var(--text)]">{b.title}</span>
                <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">
                  {b.code}
                </span>
              </div>
              {b.whatUnblocks && (
                <p className="pl-5 text-xs text-[var(--text-muted)]">
                  <span className="font-medium">Needs:</span> {b.whatUnblocks}
                </p>
              )}
            </li>
          ))}
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
        <div className="flex flex-col gap-3">
          {goals.map((g) => {
            const meta = GOAL_META[g.status];
            return (
              <div key={g.id} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm text-[var(--text)]">{g.title}</span>
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
                  <span className="text-xs tabular-nums text-[var(--text-muted)]">{g.progress}%</span>
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
// Status metadata
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

const RISK_META: Record<RiskLevel, { label: string; color: string }> = {
  CRITICAL: { label: "Critical", color: "var(--status-blocked, #dc2626)" },
  HIGH: { label: "High", color: "#ea580c" },
  MEDIUM: { label: "Medium", color: "var(--status-warn, #d97706)" },
  LOW: { label: "Low", color: "var(--text-muted, #6b7280)" },
};

const DELIVERABLE_META: Record<DeliverableStatus, { label: string; color: string }> = {
  NOT_STARTED: { label: "Not started", color: "var(--text-muted, #6b7280)" },
  IN_PROGRESS: { label: "In progress", color: "var(--status-progress, #2563eb)" },
  SUBMITTED: { label: "Submitted", color: "var(--status-progress, #2563eb)" },
  IN_GOVT_REVIEW: { label: "In govt review", color: "var(--status-warn, #d97706)" },
  ACCEPTED: { label: "Accepted", color: "var(--status-done, #16a34a)" },
  REJECTED: { label: "Rejected", color: "var(--status-blocked, #dc2626)" },
};

const BLOCKER_META: Record<BlockerType, { label: string; color: string }> = {
  INTERNAL: { label: "Internal", color: "var(--status-progress, #2563eb)" },
  EXTERNAL_GOVERNMENT: { label: "Gov", color: "var(--status-warn, #d97706)" },
  EXTERNAL_VENDOR: { label: "Vendor", color: "#7c3aed" },
};

// ---------------------------------------------------------------------------
// Helpers + small presentational pieces
// ---------------------------------------------------------------------------

function computeStats(data: PmDashboardData) {
  const slipped = data.milestones.filter(
    (m) => m.status === "MISSED" || m.status === "IN_PROGRESS",
  ).length;
  const onTarget = data.kpis.filter(isOnTarget).length;
  const risksElevated = data.risks.filter(
    (r) => r.level === "CRITICAL" || r.level === "HIGH",
  ).length;
  const blockersEscalated = data.blockers.filter((b) => b.escalate).length;
  return { slipped, onTarget, risksElevated, blockersEscalated };
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

/** One list row: a title (with optional code prefix) on the left, meta on the right. */
function Row({
  title,
  code,
  children,
}: {
  title: string;
  code?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-2.5 last:border-0">
      <span className="flex min-w-0 items-baseline gap-1.5">
        {code && (
          <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">{code}</span>
        )}
        <span className="min-w-0 truncate text-sm text-[var(--text)]">{title}</span>
      </span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </li>
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
