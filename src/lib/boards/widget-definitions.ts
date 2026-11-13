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
  /**
   * Why this type is no longer offered, when it is not.
   *
   * A retired type stays in the catalogue so a board that already saved one
   * can still name it — the tile says it was removed and why, rather than
   * going blank or quietly drawing something else under its title — but the
   * palette never offers it again. Each reason is one of two: the product
   * holds no data the widget could honestly show, or another surface already
   * does the job.
   */
  retired?: string;
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
    description: "Work created and work completed over time, as filled areas.",
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
    description: "A dial showing what share of the board's work is done, in progress or overdue.",
  },

  // ── Time (4 generics) ───────────────────────────────────────────────────────
  {
    type: "calendar-widget",
    name: "Calendar",
    category: "time",
    icon: "CalendarDays",
    defaultW: 6,
    defaultH: 5,
    description: "A month calendar of the board's work items by due date.",
  },
  {
    type: "timeline-widget",
    name: "Timeline",
    category: "time",
    icon: "AlignLeft",
    defaultW: 8,
    defaultH: 4,
    description: "Sprints and due dates on one horizontal line, with today marked.",
  },
  {
    type: "gantt",
    name: "Gantt Chart",
    category: "time",
    icon: "GanttChartSquare",
    defaultW: 10,
    defaultH: 5,
    description: "Work items with a start and due date, drawn as bars against today.",
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
    description: "The board's work items as a checklist, ticked when done, with a count of how many are finished.",
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
    description: "The board's most recently updated work items.",
  },
  {
    type: "embed-iframe",
    name: "Embed / iFrame",
    category: "content",
    icon: "Globe",
    defaultW: 6,
    defaultH: 5,
    description: "Embed any external URL in an iframe.",
    retired:
      "The app only allows frames from itself, so any outside page would load as a refused frame. Opening that up would let a board show any site inside the app. Use a Link List to point at an outside page.",
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
    retired:
      "The filter bar above every dashboard already narrows all of its widgets. A second filter inside the grid would be a second answer to the same question.",
  },
  {
    type: "quick-action",
    name: "Quick Action",
    category: "interactive",
    icon: "Zap",
    defaultW: 3,
    defaultH: 2,
    description: "A button that opens the New work item form for this project.",
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
    description: "Completed and committed story points for each finished sprint.",
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
    description: "Work items carrying an RFI number, with status, assignee and due date.",
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
    description: "Work items carrying a submittal status, with workflow status and due date.",
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
    description: "Open incidents grouped by priority, with who is assigned.",
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
    retired:
      "No SLA targets or response clocks exist in this product, so there is nothing to measure compliance against.",
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
    retired:
      "No production quantities or shift targets exist in this product.",
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
    retired:
      "No grades or assignments exist in this product.",
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
    retired:
      "No cue times exist in this product. A Deadline List shows dated work in order.",
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
    retired:
      "No utilization figure is served anywhere yet. It needs time entries and capacity behind the finance permissions, which is its own change.",
  },
];

/**
 * Returns widget definitions for the palette.
 *
 * - No sector arg → generics only (no sector skins)
 * - With sector arg → generics + skins for that sector
 * - Never a retired type: the palette offers only what a board can draw.
 */
export function getWidgetDefinitions(sector?: string): WidgetDefinition[] {
  const offered = WIDGET_DEFINITIONS.filter((w) => !w.retired);
  if (!sector) return offered.filter((w) => !w.sector);
  return offered.filter((w) => !w.sector || w.sector === sector);
}

/** The catalogue entry for a type, or undefined for a type it never had. */
export function widgetDefinition(type: string): WidgetDefinition | undefined {
  return WIDGET_DEFINITIONS.find((d) => d.type === type);
}
