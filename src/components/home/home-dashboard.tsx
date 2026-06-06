"use client";

import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, X, LayoutDashboard } from "lucide-react";
import {
  usePermissions,
  Permission,
} from "@/components/providers/permissions-provider";
import {
  HOME_WIDGET_TYPES,
  HOME_WIDGET_LABELS,
  HOME_WIDGET_SOURCE,
} from "@/lib/home/widgets";

interface HomeWidget {
  id: string;
  type: string;
}

interface PortfolioProject {
  totalItems: number;
  completedItems: number;
  inProgressItems: number;
  overdueItems: number;
}

export function HomeDashboard({ orgId }: { orgId: string }) {
  const { can } = usePermissions();
  // Portfolio-backed widgets read /analytics/portfolio (ANALYTICS_READ);
  // without it that fetch 403s, so don't offer those widgets and show "—"
  // rather than a misleading 0 if one already exists.
  const canAnalytics = can(Permission.ANALYTICS_READ);

  const widgetsKey = useOrgQueryKey("home-widgets");
  const portfolioKey = useOrgQueryKey("home", "portfolio");
  const membersKey = useOrgQueryKey("home", "members");

  const widgetsQ = useQuery({
    queryKey: widgetsKey,
    queryFn: () =>
      jsonFetch<HomeWidget[]>(`/api/v1/orgs/${orgId}/home-widgets`),
  });
  const portfolioQ = useQuery({
    queryKey: portfolioKey,
    queryFn: () =>
      jsonFetch<PortfolioProject[]>(`/api/v1/orgs/${orgId}/analytics/portfolio`),
  });
  const membersQ = useQuery({
    queryKey: membersKey,
    queryFn: () => jsonFetch<unknown[]>(`/api/v1/orgs/${orgId}/members`),
  });

  const addWidget = useOrgMutation<HomeWidget, Error, string>({
    mutationFn: (type) =>
      jsonFetch(`/api/v1/orgs/${orgId}/home-widgets`, {
        method: "POST",
        body: JSON.stringify({ type }),
      }),
    invalidate: [["home-widgets"]],
  });
  const removeWidget = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/home-widgets/${id}`, {
        method: "DELETE",
      }),
    invalidate: [["home-widgets"]],
  });

  const widgets = widgetsQ.data ?? [];
  const portfolio = portfolioQ.data ?? [];
  const members = membersQ.data ?? [];
  const metricsLoading = portfolioQ.isLoading || membersQ.isLoading;

  function metricFor(type: string): number {
    const sum = (f: (p: PortfolioProject) => number) =>
      portfolio.reduce((acc, p) => acc + (f(p) || 0), 0);
    switch (type) {
      case "open_items":
        return sum((p) => p.totalItems - p.completedItems);
      case "in_progress_items":
        return sum((p) => p.inProgressItems);
      case "completed_items":
        return sum((p) => p.completedItems);
      case "overdue_items":
        return sum((p) => p.overdueItems);
      case "team_members":
        return members.length;
      default:
        return 0;
    }
  }

  const usedTypes = new Set(widgets.map((w) => w.type));
  const available = HOME_WIDGET_TYPES.filter(
    (w) =>
      !usedTypes.has(w.type) &&
      (w.source !== "portfolio" || canAnalytics),
  );

  const addMenu =
    available.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          <Plus className="h-4 w-4 mr-1" />
          Add widget
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {available.map((w) => (
            <DropdownMenuItem
              key={w.type}
              onClick={() => addWidget.mutate(w.type)}
            >
              {w.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  if (widgetsQ.isLoading) {
    // Match the slim empty-state height (the common, seed-default case) so the
    // project grid below doesn't shift when the query resolves to no widgets.
    return (
      <div className="mb-8 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4">
        <Skeleton className="h-5 w-64" />
      </div>
    );
  }

  // Empty state: a slim prompt so the page still leads with the project grid.
  if (widgets.length === 0) {
    return (
      <div className="mb-8 flex items-center justify-between rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4">
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <LayoutDashboard className="h-4 w-4" />
          Build your dashboard — pin the metrics you care about.
        </div>
        {addMenu}
      </div>
    );
  }

  return (
    <div className="mb-10 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--text-muted)]">
          Your dashboard
        </h2>
        {addMenu}
      </div>
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {widgets.map((w) => {
          const source = HOME_WIDGET_SOURCE[w.type];
          const sourceErrored =
            source === "portfolio" ? portfolioQ.isError : membersQ.isError;
          return (
            <div key={w.id} className="group/widget relative">
              <StatCard label={HOME_WIDGET_LABELS[w.type] ?? w.type}>
                {metricsLoading ? (
                  <Skeleton className="h-8 w-16" />
                ) : sourceErrored ? (
                  // Don't show a misleading 0 when the metric source is
                  // unavailable (e.g. no ANALYTICS_READ).
                  <StatCard.Number>—</StatCard.Number>
                ) : (
                  <StatCard.Number>{metricFor(w.type)}</StatCard.Number>
                )}
              </StatCard>
              <button
                type="button"
                aria-label={`Remove ${HOME_WIDGET_LABELS[w.type] ?? w.type} widget`}
                onClick={() => removeWidget.mutate(w.id)}
                className="absolute right-2 top-2 rounded p-1 text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-[var(--primary-tint)] group-hover/widget:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
