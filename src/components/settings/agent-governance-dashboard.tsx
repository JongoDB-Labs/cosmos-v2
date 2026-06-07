"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ShieldCheck,
  ShieldAlert,
  Activity,
  ListChecks,
  Lock,
  ArrowUpRight,
} from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { cn } from "@/lib/utils";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";

/**
 * Agent Governance / Egress-Audit dashboard (AC-4 evidence + AU-6 audit review) — the gov
 * "control posture at a glance". READ-ONLY: it GETs /api/v1/orgs/[orgId]/agent-governance and
 * renders four panels — egress aggregates, recent activity, audit-chain integrity, and the
 * active governance posture. It surfaces ONLY structural metadata (counts/enums/seq); NO
 * message content / NO CUI is ever shown (the API never returns any).
 */

interface EgressSummary {
  total: number;
  exposed: number;
  withheld: number;
  withholdRate: number;
  byDecidedBy: Record<string, number>;
  byCeiling: Record<string, number>;
  byTenantClass: Record<string, number>;
}
interface RecentDecision {
  seq: string | null;
  createdAt: string;
  toolName: string | null;
  decidedBy: string;
  exposed: boolean;
  withheldCount: number;
  ceiling: string | null;
  tenantClass: string;
}
interface AuditIntegrity {
  auditLogs: "intact" | "broken";
  auditLogsReason: string | null;
  egressDecisions: "intact" | "broken";
  egressDecisionsReason: string | null;
  latestWormToSeq: string | null;
  latestCheckpointSeq: string | null;
}
interface Posture {
  tenantClass: "GOV" | "COMMERCIAL";
  agentPolicy: {
    allowedTools: string[] | null;
    deniedTools: string[];
    deniedDomains: string[];
    maxResultLimit: number | null;
    allowedProjectIds: string[] | null;
  };
  runtimeConfig: {
    enabledConnectors: string[] | null;
    breadthEnabled: boolean;
    mcpEnabled: boolean;
  };
}
interface GovernanceResponse {
  since: string | null;
  egress: EgressSummary;
  recent: RecentDecision[];
  integrity: AuditIntegrity;
  posture: Posture;
}

// Human-friendly labels + a colour cue for each decidedBy reason (the egress gate outcomes).
const DECIDED_BY_LABEL: Record<string, string> = {
  rbac: "RBAC denied",
  agentpolicy: "Agent-policy blocked",
  classification: "Classification withheld",
  tenant: "Tenant-class blocked",
  none: "Exposed (no restriction)",
  handle_mint: "Opaque handle minted",
  handle_resolve: "Handle resolved",
  handle_taint_block: "Taint blocked",
  connector_availability_block: "Connector availability blocked",
  connector_gov_block: "Connector gov-blocked",
  connector_disabled_block: "Connector disabled",
};

function decidedByVariant(reason: string): BadgeVariant {
  if (reason === "none" || reason === "handle_resolve") return "done";
  if (reason === "handle_mint") return "strategic";
  if (reason.endsWith("_block") || reason === "handle_taint_block") return "blocked";
  return "review"; // rbac / agentpolicy / classification / tenant — a withhold/deny
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function AgentGovernanceDashboard({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const queryKey = useOrgQueryKey("agent-governance");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<GovernanceResponse>(`/api/v1/orgs/${orgId}/agent-governance`),
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return <LoadError title="Couldn't load agent governance" onRetry={() => refetch()} />;
  }

  const { egress, recent, integrity, posture } = data;

  return (
    <div className="space-y-6">
      <EgressStats egress={egress} />
      <DecidedByBreakdown egress={egress} />
      <RecentDecisionsTable recent={recent} />
      <AuditIntegrityPanel integrity={integrity} />
      <PosturePanel posture={posture} orgSlug={orgSlug} />
    </div>
  );
}

/* ── Panel (a): egress stat cards ─────────────────────────────────────────────────────── */
function EgressStats({ egress }: { egress: EgressSummary }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Total decisions">
        <StatCard.Number>{egress.total.toLocaleString()}</StatCard.Number>
      </StatCard>
      <StatCard label="Exposed to model">
        <StatCard.Number>{egress.exposed.toLocaleString()}</StatCard.Number>
      </StatCard>
      <StatCard label="Withheld">
        <StatCard.Number>{egress.withheld.toLocaleString()}</StatCard.Number>
      </StatCard>
      <StatCard label="Withhold rate">
        <StatCard.Number>{pct(egress.withholdRate)}</StatCard.Number>
        <StatCard.Bar value={egress.withheld} max={Math.max(1, egress.total)} label="withheld of total" />
      </StatCard>
    </div>
  );
}

/* ── Panel (a, cont.): by-decidedBy breakdown (CSS bars; no charting dep) ──────────────── */
function DecidedByBreakdown({ egress }: { egress: EgressSummary }) {
  const entries = Object.entries(egress.byDecidedBy)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, c]) => c));

  return (
    <SectionCard
      icon={Activity}
      title="Decisions by reason"
      description="Why each egress decision resolved the way it did — the visible proof of the chokepoint."
    >
      {entries.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No egress decisions recorded yet.</p>
      ) : (
        <ul className="space-y-3">
          {entries.map(([reason, count]) => (
            <li key={reason} className="flex items-center gap-3">
              <div className="w-48 shrink-0">
                <Badge variant={decidedByVariant(reason)}>{DECIDED_BY_LABEL[reason] ?? reason}</Badge>
              </div>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--primary-tint)]">
                <div
                  className="h-full rounded-full bg-[var(--primary)]"
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-sm font-medium tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ── Panel (b): recent decisions table ────────────────────────────────────────────────── */
function RecentDecisionsTable({ recent }: { recent: RecentDecision[] }) {
  return (
    <SectionCard
      icon={ListChecks}
      title="Recent decisions"
      description="The latest egress decisions — structural metadata only (tool, reason, exposure, ceiling). No message content."
    >
      {recent.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No recent decisions.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
                <th className="py-2 pr-4 font-medium">Time</th>
                <th className="py-2 pr-4 font-medium">Tool</th>
                <th className="py-2 pr-4 font-medium">Reason</th>
                <th className="py-2 pr-4 font-medium">Exposure</th>
                <th className="py-2 pr-4 font-medium text-right">Withheld</th>
                <th className="py-2 pr-4 font-medium">Ceiling</th>
                <th className="py-2 font-medium text-right">Seq</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {recent.map((r, i) => (
                <tr key={r.seq ?? `${r.createdAt}-${i}`}>
                  <td className="py-2 pr-4 whitespace-nowrap text-[var(--text-muted)]">
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.toolName ?? "—"}</td>
                  <td className="py-2 pr-4">
                    <Badge variant={decidedByVariant(r.decidedBy)} showDot={false}>
                      {DECIDED_BY_LABEL[r.decidedBy] ?? r.decidedBy}
                    </Badge>
                  </td>
                  <td className="py-2 pr-4">
                    {r.exposed ? (
                      <span className="text-[var(--status-done-text,var(--status-done))]">Exposed</span>
                    ) : (
                      <span className="text-[var(--status-blocked-text,var(--status-blocked))]">Withheld</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{r.withheldCount}</td>
                  <td className="py-2 pr-4">{r.ceiling ?? "—"}</td>
                  <td className="py-2 text-right font-mono text-xs tabular-nums text-[var(--text-muted)]">
                    {r.seq ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

/* ── Panel (c): audit integrity badge + high-water marks ──────────────────────────────── */
function IntegrityBadge({ status }: { status: "intact" | "broken" }) {
  const intact = status === "intact";
  const Icon = intact ? ShieldCheck : ShieldAlert;
  return (
    <Badge variant={intact ? "done" : "critical"}>
      <Icon className="size-3.5" />
      {intact ? "Intact" : "BROKEN"}
    </Badge>
  );
}

function AuditIntegrityPanel({ integrity }: { integrity: AuditIntegrity }) {
  return (
    <SectionCard
      icon={Lock}
      title="Audit-chain integrity"
      description="The in-DB tamper-evident hash chain over the audit log + the egress-decision trail (AU-9 / AU-11)."
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border bg-card px-4 py-3">
            <div>
              <p className="text-sm font-medium">Audit logs</p>
              {integrity.auditLogsReason && (
                <p className="text-xs text-[var(--status-critical-text,var(--status-critical))]">
                  {integrity.auditLogsReason}
                </p>
              )}
            </div>
            <IntegrityBadge status={integrity.auditLogs} />
          </div>
          <div className="flex items-center justify-between rounded-md border bg-card px-4 py-3">
            <div>
              <p className="text-sm font-medium">Egress decisions</p>
              {integrity.egressDecisionsReason && (
                <p className="text-xs text-[var(--status-critical-text,var(--status-critical))]">
                  {integrity.egressDecisionsReason}
                </p>
              )}
            </div>
            <IntegrityBadge status={integrity.egressDecisions} />
          </div>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-center justify-between">
            <dt className="text-[var(--text-muted)]">Egress chain head (seq)</dt>
            <dd className="font-mono tabular-nums">{integrity.latestWormToSeq ?? "—"}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-[var(--text-muted)]">Latest retention checkpoint</dt>
            <dd className="font-mono tabular-nums">{integrity.latestCheckpointSeq ?? "—"}</dd>
          </div>
        </dl>
        <p className="text-xs text-[var(--text-muted)]">
          The authoritative offsite WORM watermark lives in the immutable audit bucket; this view
          shows the in-DB chain extent. Empty results from the chain walk mean the chain is intact.
        </p>
      </div>
    </SectionCard>
  );
}

/* ── Panel (d): active posture summary + links ────────────────────────────────────────── */
function tri(label: string, value: string[] | null, emptyAll: string) {
  if (value === null) return emptyAll;
  if (value.length === 0) return `${label}: none`;
  return value.join(", ");
}

function SettingsLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
      {children}
      <ArrowUpRight className="size-3.5" />
    </Link>
  );
}

function PosturePanel({ posture, orgSlug }: { posture: Posture; orgSlug: string }) {
  const { tenantClass, agentPolicy, runtimeConfig } = posture;
  const isGov = tenantClass === "GOV";

  const connectors =
    runtimeConfig.enabledConnectors === null
      ? "All registered connectors enabled"
      : runtimeConfig.enabledConnectors.length === 0
        ? "No connectors enabled"
        : runtimeConfig.enabledConnectors.join(", ");

  return (
    <SectionCard
      icon={ShieldCheck}
      title="Active governance posture"
      description="The org's tenant class, the agent policy (the middle gate), and the runtime connector posture — at a glance."
    >
      <div className="space-y-5">
        {/* Tenant class */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Tenant class</p>
            <p className="text-xs text-[var(--text-muted)]">
              {isGov ? "Gov guardrails enforced (breadth + MCP disabled)." : "Commercial — full connector breadth available."}
            </p>
          </div>
          <Badge variant={isGov ? "critical" : "strategic"}>{tenantClass}</Badge>
        </div>

        {/* Agent policy */}
        <div className="rounded-md border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium">Agent policy (middle gate)</p>
            <SettingsLink href={`/${orgSlug}/settings/agent-policy`}>Agent policy</SettingsLink>
          </div>
          <dl className="grid gap-2 text-sm">
            <Row label="Allowed tools">{agentPolicy.allowedTools === null ? "All tools allowed" : tri("Allowed", agentPolicy.allowedTools, "All tools allowed")}</Row>
            <Row label="Denied tools">{agentPolicy.deniedTools.length === 0 ? "None" : agentPolicy.deniedTools.join(", ")}</Row>
            <Row label="Denied domains">{agentPolicy.deniedDomains.length === 0 ? "None" : agentPolicy.deniedDomains.join(", ")}</Row>
            <Row label="Max result limit">{agentPolicy.maxResultLimit === null ? "No clamp" : agentPolicy.maxResultLimit}</Row>
            <Row label="Project scope">{agentPolicy.allowedProjectIds === null ? "Any project" : tri("Allowed", agentPolicy.allowedProjectIds, "Any project")}</Row>
          </dl>
        </div>

        {/* Runtime config */}
        <div className="rounded-md border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium">Runtime connectors</p>
            <div className="flex gap-2">
              <SettingsLink href={`/${orgSlug}/settings/runtime-config`}>Runtime config</SettingsLink>
              <SettingsLink href={`/${orgSlug}/settings/integrations`}>Integrations</SettingsLink>
            </div>
          </div>
          <dl className="grid gap-2 text-sm">
            <Row label="Enabled connectors">{connectors}</Row>
            <Row label="Connector breadth (Nango)">{runtimeConfig.breadthEnabled ? "Enabled" : "Disabled"}</Row>
            <Row label="External MCP">{runtimeConfig.mcpEnabled ? "Enabled" : "Disabled"}</Row>
          </dl>
        </div>
      </div>
    </SectionCard>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-[var(--text-muted)]">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
