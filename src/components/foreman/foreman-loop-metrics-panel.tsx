"use client";
// Convergence-metrics dashboard card for Foreman's loop-graph eval harness
// (Phase 4) — "is Foreman getting better or worse at delivering?". Self-fetches
// (no Suspense wrapper) and stays silent until the loop-graph has recorded
// something, same "stay silent" idiom as ForemanPulseCard.

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { SectionCard } from "@/components/ui/section-card";
import type { LoopMetrics } from "@/lib/foreman/loop/metrics";

function fmtPercent(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(0)}%`;
}

function fmtUsd(v: number | null): string {
  return v == null ? "—" : `$${v.toFixed(2)}`;
}

function fmtBySignal(bySignal: Record<string, number>): string {
  const entries = Object.entries(bySignal).filter(([, n]) => n > 0);
  if (entries.length === 0) return "No terminal loops yet.";
  return entries.map(([signal, n]) => `${n} ${signal}`).join(" · ");
}

export function ForemanLoopMetricsPanel({ orgId }: { orgId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: useOrgQueryKey("foreman-loop-metrics"),
    queryFn: () =>
      jsonFetch<{ metrics: LoopMetrics }>(`/api/v1/orgs/${orgId}/foreman/loop-metrics`),
    refetchInterval: 60_000,
  });

  if (isLoading || isError || !data) return null;
  const { metrics } = data;
  if (metrics.totalLoops === 0) return null;

  return (
    <SectionCard
      icon={Activity}
      title="Delivery convergence"
      description="How reliably Foreman's build loop converges — from the durable loop-graph."
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <div className="text-xs font-medium text-[var(--text-muted)]">Convergence rate</div>
          <div className="text-lg font-semibold text-[var(--text)]">
            {fmtPercent(metrics.convergenceRate)}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-[var(--text-muted)]">Iterations to converge</div>
          <div className="text-lg font-semibold text-[var(--text)]">
            {metrics.iterationsToConverge == null ? "—" : metrics.iterationsToConverge.p50}
          </div>
          {metrics.iterationsToConverge != null && (
            <div className="text-xs text-[var(--text-muted)]">
              mean {metrics.iterationsToConverge.mean.toFixed(1)}
            </div>
          )}
        </div>
        <div>
          <div className="text-xs font-medium text-[var(--text-muted)]">Invariant-violation rate</div>
          <div className="text-lg font-semibold text-[var(--text)]">
            {fmtPercent(metrics.invariantViolationRate)}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-[var(--text-muted)]">Cost per convergence</div>
          <div className="text-lg font-semibold text-[var(--text)]">
            {fmtUsd(metrics.costPerConvergence)}
          </div>
          <div className="text-xs text-[var(--text-muted)]">until token cost is sourced</div>
        </div>
      </div>
      <p className="mt-3 text-xs text-[var(--text-muted)]">{fmtBySignal(metrics.bySignal)}</p>
    </SectionCard>
  );
}
