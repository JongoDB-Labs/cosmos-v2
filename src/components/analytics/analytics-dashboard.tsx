"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BarChart3,
  TrendingUp,
  AlertTriangle,
  FolderKanban,
  Activity,
  Zap,
  Clock,
  Trophy,
} from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "@/components/charts/lazy-recharts";

interface SprintAnalytics {
  sprintId: string;
  sprintName: string;
  velocity: number;
  completedPoints: number;
  totalPoints: number;
  completedItems: number;
  totalItems: number;
  avgCycleTimeDays: number;
  avgLeadTimeDays: number;
}

interface PortfolioProject {
  projectId: string;
  projectName: string;
  projectKey: string;
  totalItems: number;
  completedItems: number;
  inProgressItems: number;
  overdueItems: number;
  completionPercent: number;
  activeSprint: string | null;
}

interface ProjectDetail {
  byType: { name: string; value: number }[];
  byPriority: { name: string; value: number }[];
  byStatus: { name: string; value: number }[];
  completionTrend: { date: string; completed: number }[];
  topAssignees: { name: string; count: number }[];
}

interface Project {
  id: string;
  name: string;
  key: string;
}

interface AnalyticsDashboardProps {
  orgId: string;
}

type TabValue = "portfolio" | "sprint" | "project";

const CHART_COLORS = [
  "var(--color-primary)",
  "var(--color-chart-2, #10b981)",
  "var(--color-chart-3, #f59e0b)",
  "var(--color-chart-4, #ef4444)",
  "var(--color-chart-5, #8b5cf6)",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

const PIE_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export function AnalyticsDashboard({ orgId }: AnalyticsDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabValue>("portfolio");

  const tabs: { value: TabValue; label: string; icon: React.ReactNode }[] = [
    { value: "portfolio", label: "Portfolio", icon: <FolderKanban className="size-4" /> },
    { value: "sprint", label: "Sprint Velocity", icon: <Zap className="size-4" /> },
    { value: "project", label: "Project Detail", icon: <BarChart3 className="size-4" /> },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Title/subtitle owned by the page shell (PageShell). max-w-full +
          overflow-x lets the strip scroll instead of clipping the last tab on
          narrow screens. */}
      <div className="flex max-w-full items-center gap-1 overflow-x-auto scrollbar-x rounded-lg border bg-muted/30 p-1 md:w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              activeTab === tab.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "portfolio" && <PortfolioTab orgId={orgId} />}
      {activeTab === "sprint" && <SprintVelocityTab orgId={orgId} />}
      {activeTab === "project" && <ProjectDetailTab orgId={orgId} />}
    </div>
  );
}

function PortfolioTab({ orgId }: { orgId: string }) {
  const [projects, setProjects] = useState<PortfolioProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/analytics/portfolio`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProjects(Array.isArray(data) ? data : data.projects || []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const totalProjects = projects.length;
  const avgCompletion =
    totalProjects > 0
      ? Math.round(
          projects.reduce((sum, p) => sum + (p.completionPercent || 0), 0) /
            totalProjects
        ) || 0
      : 0;
  const totalOverdue = projects.reduce((sum, p) => sum + p.overdueItems, 0);

  if (loading) {
    // Minimal skeleton (low-CLS): a single modest placeholder that the real
    // content grows past, instead of a tall multi-section skeleton that would
    // collapse upward on an empty/sparse state.
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (loadError) {
    return <LoadError onRetry={() => void load()} />;
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16">
        <FolderKanban className="size-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No project data available</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard
          icon={<FolderKanban className="size-4" />}
          label="Total Projects"
          value={totalProjects.toString()}
        />
        <SummaryCard
          icon={<TrendingUp className="size-4" />}
          label="Avg Completion"
          value={`${avgCompletion}%`}
        />
        <SummaryCard
          icon={<AlertTriangle className="size-4" />}
          label="Total Overdue"
          value={totalOverdue.toString()}
          variant={totalOverdue > 0 ? "warning" : "default"}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <PortfolioCard key={project.projectId} project={project} />
        ))}
      </div>
    </div>
  );
}

function PortfolioCard({ project }: { project: PortfolioProject }) {
  // Guard against a missing/NaN value: without this, `undefined` falls through
  // every threshold to the red branch and renders a bare "%" with a NaN-width
  // (i.e. full red) bar.
  const pct = project.completionPercent ?? 0;
  // 0% means "not started", not "failing" — keep it neutral. Red/amber/green
  // only encode actual progress once there is some. (Overdue has its own red
  // indicator below.)
  const barColor =
    pct <= 0
      ? "bg-muted-foreground/30"
      : pct >= 70
        ? "bg-green-500"
        : pct >= 30
          ? "bg-yellow-500"
          : "bg-red-500";
  const textColor =
    pct <= 0
      ? "text-muted-foreground"
      : pct >= 70
        ? "text-green-600 dark:text-green-400"
        : pct >= 30
          ? "text-yellow-600 dark:text-yellow-400"
          : "text-red-600 dark:text-red-400";

  return (
    <div className="rounded-lg border bg-background p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-sm truncate">{project.projectName}</h3>
          <span className="text-xs text-muted-foreground">{project.projectKey}</span>
        </div>
        <span className={cn("text-lg font-bold tabular-nums", textColor)}>
          {pct}%
        </span>
      </div>

      <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Total</span>
          <span className="font-medium">{project.totalItems}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Done</span>
          <span className="font-medium">{project.completedItems}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">In Progress</span>
          <span className="font-medium">{project.inProgressItems}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Overdue</span>
          <span className={cn("font-medium", project.overdueItems > 0 && "text-red-500")}>
            {project.overdueItems}
          </span>
        </div>
      </div>

      {project.activeSprint && (
        <div className="pt-1 border-t">
          <span className="text-xs text-muted-foreground">Sprint: </span>
          <Badge variant="neutral" className="text-[10px]">
            {project.activeSprint}
          </Badge>
        </div>
      )}
    </div>
  );
}

function SprintVelocityTab({ orgId }: { orgId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [sprints, setSprints] = useState<SprintAnalytics[]>([]);
  const [loading, setLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    (async () => {
      setProjectsLoading(true);
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/projects`);
        if (res.ok) {
          const data = await res.json();
          const list: Project[] = Array.isArray(data) ? data : data.projects || [];
          setProjects(list);
          if (list.length > 0) setSelectedProjectId(list[0].id);
        }
      } catch {
        /* ignore */
      } finally {
        setProjectsLoading(false);
      }
    })();
  }, [orgId]);

  const loadVelocity = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/analytics/sprints?projectId=${selectedProjectId}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSprints(Array.isArray(data) ? data : data.sprints || []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId, selectedProjectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadVelocity();
  }, [loadVelocity]);

  const avgVelocity =
    sprints.length > 0
      ? Math.round(
          sprints.reduce((sum, s) => sum + s.velocity, 0) / sprints.length
        )
      : 0;
  const avgCycleTime =
    sprints.length > 0
      ? (
          sprints.reduce((sum, s) => sum + s.avgCycleTimeDays, 0) /
          sprints.length
        ).toFixed(1)
      : "0";
  const avgLeadTime =
    sprints.length > 0
      ? (
          sprints.reduce((sum, s) => sum + s.avgLeadTimeDays, 0) /
          sprints.length
        ).toFixed(1)
      : "0";
  const bestSprint =
    sprints.length > 0
      ? sprints.reduce((best, s) => (s.velocity > best.velocity ? s : best))
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Project</span>
        {projectsLoading ? (
          <Skeleton className="h-8 w-48" />
        ) : (
          <Select
            items={Object.fromEntries(projects.map((p) => [p.id, p.name]))}
            value={selectedProjectId}
            onValueChange={(v) => setSelectedProjectId(v ?? "")}
          >
            <SelectTrigger className="w-60">
              <SelectValue placeholder="Select a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {loading ? (
        // Minimal skeleton (low-CLS): one modest placeholder below the project
        // row, not a tall chart + stat-card grid that collapses on sparse data.
        <Skeleton className="h-64 rounded-lg" />
      ) : loadError ? (
        <LoadError onRetry={() => void loadVelocity()} />
      ) : !selectedProjectId ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16">
          <Zap className="size-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Select a project to view sprint velocity</p>
        </div>
      ) : sprints.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16">
          <Activity className="size-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No sprint data available for this project</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border bg-background p-4">
            <h3 className="text-sm font-semibold mb-4">Sprint Velocity</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={sprints}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="sprintName"
                  tick={{ fontSize: 12 }}
                  className="fill-muted-foreground"
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  className="fill-muted-foreground"
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Legend />
                <Bar
                  dataKey="velocity"
                  name="Velocity"
                  fill="var(--color-primary)"
                  radius={[4, 4, 0, 0]}
                />
                <ReferenceLine
                  y={avgVelocity}
                  stroke="var(--color-chart-2, #10b981)"
                  strokeDasharray="3 3"
                  label={{
                    value: `Avg: ${avgVelocity}`,
                    position: "right",
                    fontSize: 11,
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <SummaryCard
              icon={<Zap className="size-4" />}
              label="Avg Velocity"
              value={avgVelocity.toString()}
            />
            <SummaryCard
              icon={<Clock className="size-4" />}
              label="Avg Cycle Time"
              value={`${avgCycleTime}d`}
            />
            <SummaryCard
              icon={<Activity className="size-4" />}
              label="Avg Lead Time"
              value={`${avgLeadTime}d`}
            />
            <SummaryCard
              icon={<Trophy className="size-4" />}
              label="Best Sprint"
              value={bestSprint?.sprintName ?? "-"}
              subtitle={bestSprint ? `${bestSprint.velocity} pts` : undefined}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ProjectDetailTab({ orgId }: { orgId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    (async () => {
      setProjectsLoading(true);
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/projects`);
        if (res.ok) {
          const data = await res.json();
          const list: Project[] = Array.isArray(data) ? data : data.projects || [];
          setProjects(list);
          if (list.length > 0) setSelectedProjectId(list[0].id);
        }
      } catch {
        /* ignore */
      } finally {
        setProjectsLoading(false);
      }
    })();
  }, [orgId]);

  const loadDetail = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/analytics/projects/${selectedProjectId}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDetail(data);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId, selectedProjectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDetail();
  }, [loadDetail]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Project</span>
        {projectsLoading ? (
          <Skeleton className="h-8 w-48" />
        ) : (
          <Select
            items={Object.fromEntries(projects.map((p) => [p.id, p.name]))}
            value={selectedProjectId}
            onValueChange={(v) => setSelectedProjectId(v ?? "")}
          >
            <SelectTrigger className="w-60">
              <SelectValue placeholder="Select a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {loading ? (
        // Minimal skeleton (low-CLS): one modest placeholder below the project
        // row, not a four-chart grid that collapses when a project has no data.
        <Skeleton className="h-64 rounded-lg" />
      ) : loadError ? (
        <LoadError onRetry={() => void loadDetail()} />
      ) : !selectedProjectId ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16">
          <BarChart3 className="size-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Select a project to view details</p>
        </div>
      ) : !detail ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16">
          <BarChart3 className="size-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No data available for this project</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border bg-background p-4">
              <h3 className="text-sm font-semibold mb-4">Items by Type</h3>
              {detail.byType.length > 0 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={detail.byType}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                      nameKey="name"
                    >
                      {detail.byType.map((_, i) => (
                        <Cell
                          key={i}
                          fill={PIE_COLORS[i % PIE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                    />
                    <Legend
                      iconType="circle"
                      iconSize={8}
                      wrapperStyle={{ fontSize: "12px" }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChartState />
              )}
            </div>

            <div className="rounded-lg border bg-background p-4">
              <h3 className="text-sm font-semibold mb-4">Items by Priority</h3>
              {detail.byPriority.length > 0 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={detail.byPriority} layout="vertical">
                    <CartesianGrid
                      strokeDasharray="3 3"
                      className="stroke-border"
                    />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 12 }}
                      className="fill-muted-foreground"
                    />
                    <YAxis
                      dataKey="name"
                      type="category"
                      tick={{ fontSize: 12 }}
                      width={80}
                      className="fill-muted-foreground"
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                    />
                    <Bar
                      dataKey="value"
                      name="Items"
                      fill="var(--color-primary)"
                      radius={[0, 4, 4, 0]}
                    >
                      {detail.byPriority.map((_, i) => (
                        <Cell
                          key={i}
                          fill={CHART_COLORS[i % CHART_COLORS.length]}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChartState />
              )}
            </div>

            <div className="rounded-lg border bg-background p-4">
              <h3 className="text-sm font-semibold mb-4">Items by Status</h3>
              {detail.byStatus.length > 0 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={detail.byStatus}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                      nameKey="name"
                    >
                      {detail.byStatus.map((_, i) => (
                        <Cell
                          key={i}
                          fill={PIE_COLORS[i % PIE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                    />
                    <Legend
                      iconType="circle"
                      iconSize={8}
                      wrapperStyle={{ fontSize: "12px" }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChartState />
              )}
            </div>

            <div className="rounded-lg border bg-background p-4">
              <h3 className="text-sm font-semibold mb-4">
                Completion Trend (Last 30 Days)
              </h3>
              {detail.completionTrend.length > 0 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={detail.completionTrend}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      className="stroke-border"
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11 }}
                      className="fill-muted-foreground"
                      tickFormatter={(val) => {
                        const d = new Date(val);
                        return `${d.getMonth() + 1}/${d.getDate()}`;
                      }}
                    />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      className="fill-muted-foreground"
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      labelFormatter={(val) => {
                        const d = new Date(val);
                        return d.toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        });
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="completed"
                      name="Completed"
                      stroke="var(--color-primary)"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChartState />
              )}
            </div>
          </div>

          {detail.topAssignees.length > 0 && (
            <div className="rounded-lg border bg-background p-4">
              <h3 className="text-sm font-semibold mb-4">Top Assignees</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 pr-4 font-medium text-muted-foreground">
                        Name
                      </th>
                      <th className="text-left py-2 pr-4 font-medium text-muted-foreground w-20">
                        Items
                      </th>
                      <th className="text-left py-2 font-medium text-muted-foreground">
                        Distribution
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.topAssignees.map((assignee, i) => {
                      const maxCount = detail.topAssignees[0]?.count ?? 1;
                      const pct = Math.round(
                        (assignee.count / maxCount) * 100
                      );
                      return (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-2 pr-4 font-medium">
                            {assignee.name}
                          </td>
                          <td className="py-2 pr-4 tabular-nums">
                            {assignee.count}
                          </td>
                          <td className="py-2">
                            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-primary transition-all"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  subtitle,
  variant = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle?: string;
  variant?: "default" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-background p-4 flex flex-col gap-1",
        variant === "warning" && "border-yellow-500/30"
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <span className="text-2xl font-bold tracking-tight truncate">
        {value}
      </span>
      {subtitle && (
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      )}
    </div>
  );
}

function EmptyChartState() {
  return (
    <div className="flex items-center justify-center h-[240px] text-sm text-muted-foreground">
      No data available
    </div>
  );
}
