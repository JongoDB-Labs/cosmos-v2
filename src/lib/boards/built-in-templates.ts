import type { BoardType } from "@prisma/client";

interface TemplateBase {
  slug: string;
  name: string;
  category: string;
  methodology?: string;
  description: string;
  icon: string;
}

/**
 * A template either creates a Board row or enables a project feature — never
 * both. The gallery branches on which key is present, so modelling it as a
 * union keeps a malformed entry (both, or neither) from compiling.
 */
export type BuiltInBoardTemplate =
  | (TemplateBase & {
      boardType: BoardType;
      config?: Record<string, unknown>;
      feature?: never;
    })
  | (TemplateBase & { feature: string; boardType?: never; config?: never });

/** The subset that creates boards — what board-type coverage is judged against. */
export function boardTypeTemplates() {
  return BUILT_IN_BOARD_TEMPLATES.filter(
    (t): t is Extract<BuiltInBoardTemplate, { boardType: BoardType }> =>
      "boardType" in t && t.boardType !== undefined
  );
}

/**
 * The board templates the "new board" gallery offers.
 *
 * This list is what makes a board type CREATABLE. The registry in
 * `board-types.ts` guarantees a type has a label and a view; it cannot
 * guarantee a user can reach it, because that depends on an entry here. A type
 * missing from this list renders correctly and is unreachable — which is how a
 * finished feature ships that nobody can open.
 *
 * `built-in-templates.test.ts` asserts every BoardType appears here.
 */
export const BUILT_IN_BOARD_TEMPLATES: BuiltInBoardTemplate[] = [
  {
    slug: "kanban",
    name: "Kanban Board",
    category: "agile",
    methodology: "kanban",
    description: "Visual workflow with drag-drop columns, WIP limits, and swimlanes",
    icon: "Columns3",
    boardType: "KANBAN",
  },
  {
    slug: "scrum",
    name: "Scrum Board",
    category: "agile",
    methodology: "scrum",
    description: "Sprint-focused board with burndown charts and velocity tracking",
    icon: "Timer",
    boardType: "SCRUM",
  },
  {
    slug: "backlog",
    name: "Backlog",
    category: "agile",
    description: "Prioritized list with sprint assignment and story point estimation",
    icon: "ListOrdered",
    boardType: "BACKLOG",
  },
  {
    slug: "table",
    name: "Table View",
    category: "agile",
    description: "Configurable columns with sorting, grouping, and inline editing",
    icon: "Table2",
    boardType: "TABLE",
  },
  {
    slug: "timeline",
    name: "Timeline / Gantt",
    category: "planning",
    methodology: "waterfall",
    description: "Interactive scheduler — drag to reschedule, dependencies, critical path",
    icon: "GanttChart",
    boardType: "TIMELINE",
  },
  {
    slug: "release-timeline",
    name: "Release Timeline",
    category: "planning",
    description: "Static big-picture snapshot — increments, deliverables & milestones by month",
    icon: "CalendarRange",
    boardType: "TIMELINE",
    config: { mode: "release-timeline" },
  },
  {
    slug: "roadmap",
    name: "Roadmap",
    category: "planning",
    description: "Strategic epic swimlanes across increments, with feature roll-up",
    icon: "Map",
    boardType: "ROADMAP",
  },
  {
    slug: "calendar",
    name: "Calendar",
    category: "planning",
    description: "Sprint ceremonies, due dates, month/week/day views",
    icon: "CalendarDays",
    boardType: "CALENDAR",
  },
  {
    slug: "okr",
    name: "OKR View",
    category: "strategy",
    methodology: "okr",
    description: "Objectives with key results, hierarchical status, and confidence scoring",
    icon: "Target",
    boardType: "OKR",
  },
  {
    slug: "portfolio",
    name: "Portfolio",
    category: "strategy",
    description: "Cross-project status grid with resource allocation and budget tracking",
    icon: "LayoutGrid",
    boardType: "PORTFOLIO",
  },
  {
    slug: "dashboard",
    name: "Dashboard",
    category: "analytics",
    description: "Custom widget composition with metrics, charts, lists, and status summaries",
    icon: "BarChart3",
    boardType: "DASHBOARD",
  },
  {
    slug: "raid",
    name: "RAID Log",
    category: "tracking",
    methodology: "waterfall",
    description: "Risks, Actions, Issues, Decisions table with severity, owner, and status",
    icon: "ShieldAlert",
    boardType: "RAID",
  },
  {
    slug: "cfd",
    name: "Cumulative Flow",
    category: "analytics",
    methodology: "kanban",
    description: "Stacked area chart showing work item distribution over time",
    icon: "AreaChart",
    boardType: "CFD",
  },
  {
    slug: "program",
    name: "Program Board (SAFe)",
    category: "enterprise",
    methodology: "safe",
    description: "PI planning grid with team swimlanes and feature-to-team mapping",
    icon: "Network",
    boardType: "PROGRAM",
  },
  {
    // A FEATURE view (not a board type): selecting it enables the project's
    // `pm-dashboard` feature flag and opens the dashboard, rather than creating a
    // Board row. The gallery branches on `feature` vs `boardType`.
    slug: "pm-dashboard",
    name: "PM Dashboard",
    category: "enterprise",
    methodology: "govcon",
    description: "GovCon program-management suite: risk, change, blocker, schedule, deliverables, vendors, staffing & CLIN registers with drill-down, derived metrics, and Excel export.",
    icon: "BarChart3",
    feature: "pm-dashboard",
  },
  {
    slug: "sprint-planning",
    name: "Sprint Planning",
    category: "agile",
    methodology: "scrum",
    description: "Capacity, commitment and the goal for the sprint ahead",
    icon: "ClipboardList",
    boardType: "SPRINT_PLANNING",
  },
  {
    slug: "sprint-review",
    name: "Sprint Review / Retro",
    category: "agile",
    methodology: "scrum",
    description:
      "What shipped, what carried, Start/Stop/Continue and action items — derived from your sprint",
    icon: "PresentationIcon",
    boardType: "SPRINT_REVIEW",
  },
];
