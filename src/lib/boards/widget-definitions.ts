export interface WidgetDefinition {
  type: string;
  name: string;
  category: "data" | "time" | "content" | "interactive";
  icon: string; // lucide icon name
  defaultW: number;
  defaultH: number;
  sector?: string; // undefined = generic, "software" = sector skin
  description: string;
  baseType?: string; // for skins — the generic type this is based on
  presetConfig?: Record<string, unknown>; // pre-filled config for skins
}

export const WIDGET_DEFINITIONS: WidgetDefinition[] = [
  // ── Data (10 generics) ──────────────────────────────────────────────────────
  {
    type: "counter",
    name: "Counter",
    category: "data",
    icon: "Hash",
    defaultW: 3,
    defaultH: 2,
    description: "A single numeric count, optionally with a label and trend.",
  },
  {
    type: "kpi-card",
    name: "KPI Card",
    category: "data",
    icon: "TrendingUp",
    defaultW: 3,
    defaultH: 2,
    description: "Key performance indicator with value, target, and delta.",
  },
  {
    type: "bar-chart",
    name: "Bar Chart",
    category: "data",
    icon: "BarChart3",
    defaultW: 6,
    defaultH: 4,
    description: "Vertical or horizontal bar chart for categorical comparisons.",
  },
  {
    type: "line-chart",
    name: "Line Chart",
    category: "data",
    icon: "LineChart",
    defaultW: 6,
    defaultH: 4,
    description: "Time-series or continuous data plotted as a line.",
  },
  {
    type: "area-chart",
    name: "Area Chart",
    category: "data",
    icon: "AreaChart",
    defaultW: 6,
    defaultH: 4,
    description: "Line chart with a filled area underneath.",
  },
  {
    type: "pie-chart",
    name: "Pie Chart",
    category: "data",
    icon: "PieChart",
    defaultW: 4,
    defaultH: 4,
    description: "Proportional breakdown of a dataset as slices.",
  },
  {
    type: "table",
    name: "Table",
    category: "data",
    icon: "Table2",
    defaultW: 8,
    defaultH: 5,
    description: "Tabular data with sortable columns.",
  },
  {
    type: "list",
    name: "List",
    category: "data",
    icon: "List",
    defaultW: 4,
    defaultH: 4,
    description: "Simple ordered or unordered list of items.",
  },
  {
    type: "grouped-list",
    name: "Grouped List",
    category: "data",
    icon: "ListTree",
    defaultW: 5,
    defaultH: 5,
    description: "Items grouped under expandable section headers.",
  },
  {
    type: "gauge",
    name: "Gauge",
    category: "data",
    icon: "Gauge",
    defaultW: 3,
    defaultH: 3,
    description: "Dial gauge showing a value within a defined range.",
  },

  // ── Time (4 generics) ───────────────────────────────────────────────────────
  {
    type: "calendar-widget",
    name: "Calendar",
    category: "time",
    icon: "CalendarDays",
    defaultW: 6,
    defaultH: 5,
    description: "Monthly or weekly calendar view with events.",
  },
  {
    type: "timeline-widget",
    name: "Timeline",
    category: "time",
    icon: "AlignLeft",
    defaultW: 8,
    defaultH: 4,
    description: "Horizontal timeline of events or milestones.",
  },
  {
    type: "gantt",
    name: "Gantt Chart",
    category: "time",
    icon: "GanttChartSquare",
    defaultW: 10,
    defaultH: 5,
    description: "Project schedule with task bars and dependencies.",
  },
  {
    type: "deadline-list",
    name: "Deadline List",
    category: "time",
    icon: "AlarmClock",
    defaultW: 4,
    defaultH: 4,
    description: "Upcoming deadlines sorted by due date.",
  },

  // ── Content (5 generics) ────────────────────────────────────────────────────
  {
    type: "text-block",
    name: "Text Block",
    category: "content",
    icon: "Type",
    defaultW: 6,
    defaultH: 3,
    description: "Rich text block for notes, headers, or descriptions.",
  },
  {
    type: "checklist",
    name: "Checklist",
    category: "content",
    icon: "ListChecks",
    defaultW: 4,
    defaultH: 4,
    description: "Interactive checklist with completion tracking.",
  },
  {
    type: "link-list",
    name: "Link List",
    category: "content",
    icon: "Link",
    defaultW: 4,
    defaultH: 3,
    description: "Curated list of bookmarks or resource links.",
  },
  {
    type: "activity-feed",
    name: "Activity Feed",
    category: "content",
    icon: "Activity",
    defaultW: 4,
    defaultH: 5,
    description: "Live stream of recent activity events.",
  },
  {
    type: "embed-iframe",
    name: "Embed / iFrame",
    category: "content",
    icon: "Globe",
    defaultW: 6,
    defaultH: 5,
    description: "Embed any external URL in an iframe.",
  },

  // ── Interactive (2 generics) ────────────────────────────────────────────────
  {
    type: "filter",
    name: "Filter",
    category: "interactive",
    icon: "SlidersHorizontal",
    defaultW: 12,
    defaultH: 1,
    description: "Global filter bar that controls other widgets on the board.",
  },
  {
    type: "quick-action",
    name: "Quick Action",
    category: "interactive",
    icon: "Zap",
    defaultW: 3,
    defaultH: 2,
    description: "Button or shortcut that triggers a pre-configured action.",
  },

  // ── Sector skins — software ─────────────────────────────────────────────────
  {
    type: "software.burndown",
    name: "Burndown Chart",
    category: "data",
    icon: "TrendingDown",
    defaultW: 6,
    defaultH: 4,
    sector: "software",
    baseType: "line-chart",
    description: "Sprint burndown showing remaining work vs ideal line.",
    presetConfig: {
      title: "Sprint Burndown",
      xAxisKey: "day",
      seriesKeys: ["remaining", "ideal"],
      yAxisLabel: "Story Points",
    },
  },
  {
    type: "software.velocity",
    name: "Velocity Chart",
    category: "data",
    icon: "BarChart3",
    defaultW: 6,
    defaultH: 4,
    sector: "software",
    baseType: "bar-chart",
    description: "Per-sprint velocity showing completed vs committed points.",
    presetConfig: {
      title: "Team Velocity",
      xAxisKey: "sprint",
      seriesKeys: ["completed", "committed"],
      yAxisLabel: "Story Points",
    },
  },

  // ── Sector skins — aec ──────────────────────────────────────────────────────
  {
    type: "aec.rfi-tracker",
    name: "RFI Tracker",
    category: "data",
    icon: "Table2",
    defaultW: 8,
    defaultH: 5,
    sector: "aec",
    baseType: "table",
    description: "Request-for-information log with status, ball-in-court, and due date.",
    presetConfig: {
      title: "RFI Log",
      columns: ["rfiNumber", "subject", "status", "ballInCourt", "dueDate"],
    },
  },
  {
    type: "aec.submittal-log",
    name: "Submittal Log",
    category: "data",
    icon: "Table2",
    defaultW: 8,
    defaultH: 5,
    sector: "aec",
    baseType: "table",
    description: "Submittal register tracking spec section, revision, and review status.",
    presetConfig: {
      title: "Submittal Log",
      columns: ["submittalNumber", "specSection", "description", "revision", "status", "returnDate"],
    },
  },

  // ── Sector skins — ops ──────────────────────────────────────────────────────
  {
    type: "ops.incident-summary",
    name: "Incident Summary",
    category: "data",
    icon: "ListTree",
    defaultW: 5,
    defaultH: 5,
    sector: "ops",
    baseType: "grouped-list",
    description: "Active incidents grouped by severity with responder info.",
    presetConfig: {
      title: "Incident Summary",
      groupBy: "severity",
      groupOrder: ["P1", "P2", "P3", "P4"],
    },
  },
  {
    type: "ops.sla-gauge",
    name: "SLA Gauge",
    category: "data",
    icon: "Gauge",
    defaultW: 3,
    defaultH: 3,
    sector: "ops",
    baseType: "gauge",
    description: "SLA compliance percentage against defined targets.",
    presetConfig: {
      title: "SLA Compliance",
      minValue: 0,
      maxValue: 100,
      thresholds: [{ value: 95, color: "green" }, { value: 80, color: "yellow" }, { value: 0, color: "red" }],
      unit: "%",
    },
  },

  // ── Sector skins — manufacturing ────────────────────────────────────────────
  {
    type: "manufacturing.output",
    name: "Production Output",
    category: "data",
    icon: "BarChart3",
    defaultW: 6,
    defaultH: 4,
    sector: "manufacturing",
    baseType: "bar-chart",
    description: "Daily or shift production output vs target.",
    presetConfig: {
      title: "Production Output",
      xAxisKey: "shift",
      seriesKeys: ["actual", "target"],
      yAxisLabel: "Units",
    },
  },

  // ── Sector skins — education ────────────────────────────────────────────────
  {
    type: "education.gradebook",
    name: "Gradebook",
    category: "data",
    icon: "Table2",
    defaultW: 8,
    defaultH: 5,
    sector: "education",
    baseType: "table",
    description: "Student grade table with assignment columns and averages.",
    presetConfig: {
      title: "Gradebook",
      columns: ["student", "assignment1", "assignment2", "midterm", "final", "average"],
      showRowAverages: true,
    },
  },

  // ── Sector skins — event ────────────────────────────────────────────────────
  {
    type: "event.run-of-show",
    name: "Run of Show",
    category: "time",
    icon: "AlignLeft",
    defaultW: 8,
    defaultH: 4,
    sector: "event",
    baseType: "timeline-widget",
    description: "Ordered event schedule with cue times and owners.",
    presetConfig: {
      title: "Run of Show",
      timeFormat: "HH:mm",
      showOwner: true,
      showNotes: true,
    },
  },

  // ── Sector skins — consulting ───────────────────────────────────────────────
  {
    type: "consulting.utilization",
    name: "Utilization Gauge",
    category: "data",
    icon: "Gauge",
    defaultW: 3,
    defaultH: 3,
    sector: "consulting",
    baseType: "gauge",
    description: "Consultant or team utilization rate against target.",
    presetConfig: {
      title: "Utilization",
      minValue: 0,
      maxValue: 100,
      thresholds: [{ value: 80, color: "green" }, { value: 60, color: "yellow" }, { value: 0, color: "red" }],
      unit: "%",
    },
  },
];

/**
 * Returns widget definitions for the palette.
 *
 * - No sector arg → generics only (no sector skins)
 * - With sector arg → generics + skins for that sector
 */
export function getWidgetDefinitions(sector?: string): WidgetDefinition[] {
  if (!sector) return WIDGET_DEFINITIONS.filter((w) => !w.sector);
  return WIDGET_DEFINITIONS.filter((w) => !w.sector || w.sector === sector);
}
