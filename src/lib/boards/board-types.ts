import { BoardType, type ColumnCategory } from "@prisma/client";

export interface BoardTypeDef {
  /** What a person reads. e2e specs locate boards by this, so it is a contract. */
  label: string;
  /** One line explaining what the board is for, shown beside the label. */
  description: string;
  /**
   * Whether "Save as board" may produce this type from a filtered work-item
   * view. Only types that render a list of work items qualify — a ceremony or a
   * chart cannot be built out of a filter.
   */
  savableFromView: boolean;
  /**
   * Whether the board's columns are the project's STATUSES (a view onto
   * `workflow_statuses`). False only for the ceremony boards, whose columns are
   * prompts (Start / Stop / Continue) that retro notes sit under: they must
   * never become statuses an item could be moved to.
   */
  columnsAreStatuses: boolean;
  /**
   * Whether this type's view READS `Board.config.widgets` — the layout the
   * widget builder at `boards/[boardId]/builder` saves.
   *
   * It lives on the registry rather than in a set beside the builder because
   * the honest answer is per-view, and a total Record makes a new BoardType
   * state it. The builder will happily save widgets onto ANY board (its PUT
   * goes to the generic board route), so this is the only thing that says
   * whether anything would ever draw them: offering the builder from a type
   * where this is false is a one-click path to a layout no screen displays.
   *
   * True only for the three types `BOARD_VIEWS` maps to `DashboardView`.
   */
  rendersSavedWidgets: boolean;
  /**
   * Columns to create with the board.
   *
   * Only for types whose columns ARE the board's structure rather than a team's
   * workflow — a retro needs its prompts to exist or there is nowhere to put a
   * note. Delivery boards are left alone: seeding opinionated columns onto a
   * Kanban board would fight whatever the project template already set up.
   */
  defaultColumns?: {
    name: string;
    key: string;
    color: string;
    category: ColumnCategory;
  }[];
}

/**
 * The single source of truth for board types.
 *
 * Before this, the set was spelled out three times — the Prisma enum,
 * `BOARD_TYPE_OPTIONS` in project settings, and `BOARD_TYPES` in the
 * save-as-board dialog — and none of them derived from another. A type added to
 * the enum but forgotten in the options array existed in the database and was
 * uncreatable in the UI, with nothing to catch it.
 *
 * Typed as a total Record, so adding a member to the enum fails the build here,
 * the same guarantee `PROJECT_STATUS_LABELS` gives project status.
 */
export const BOARD_TYPE_REGISTRY: Record<BoardType, BoardTypeDef> = {
  KANBAN: {
    label: "Kanban",
    description: "Drag-drop columns with WIP limits & swimlanes.",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: false,
  },
  SCRUM: {
    label: "Scrum / Sprint",
    description: "Active-sprint board with the Kanban scoped to it.",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: false,
  },
  BACKLOG: {
    label: "Backlog",
    description: "Ranked product backlog with sprint assignment.",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: false,
  },
  TABLE: {
    label: "Table",
    description: "Sortable, filterable spreadsheet-style grid.",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: false,
  },
  CALENDAR: {
    label: "Calendar",
    description: "Due dates & ceremonies on a month/week view.",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: false,
  },
  TIMELINE: {
    label: "Timeline / Gantt",
    description:
      "Interactive schedule with dependencies (or a static Release Timeline).",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: false,
  },
  ROADMAP: {
    label: "Roadmap",
    description: "Strategic epic swimlanes across increments.",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: false,
  },
  OKR: {
    label: "OKRs",
    description: "Objectives & key results.",
    savableFromView: false,
    columnsAreStatuses: true,
    rendersSavedWidgets: false,
  },
  DASHBOARD: {
    label: "Dashboard",
    description: "Rollup widgets & metrics.",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: true,
  },
  PORTFOLIO: {
    label: "Portfolio",
    description: "Cross-project rollup dashboard.",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: true,
  },
  PROGRAM: {
    label: "Program",
    description: "Program-level rollup dashboard.",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: true,
  },
  RAID: {
    label: "RAID Log",
    description: "Risks, assumptions, issues & dependencies.",
    savableFromView: true,
    columnsAreStatuses: true,
    rendersSavedWidgets: false,
  },
  CFD: {
    label: "Cumulative Flow",
    description: "Cumulative-flow diagram of work over time.",
    savableFromView: false,
    columnsAreStatuses: true,
    rendersSavedWidgets: false,
  },
  SPRINT_PLANNING: {
    label: "Sprint Planning",
    description: "Capacity, commitment & the goal for the sprint ahead.",
    savableFromView: false,
    columnsAreStatuses: false,
    rendersSavedWidgets: false,
    // Planning captures a different conversation from a retro: what could stop
    // us, what we do not know yet, and what we settled.
    defaultColumns: [
      { name: "Risks", key: "risks", color: "#A32C2C", category: "TODO" },
      { name: "Questions", key: "questions", color: "#C9A227", category: "TODO" },
      { name: "Decisions", key: "decisions", color: "#2E7D52", category: "TODO" },
    ],
  },
  SPRINT_REVIEW: {
    label: "Sprint Review / Retro",
    description:
      "What shipped, what carried, Start/Stop/Continue & action items.",
    savableFromView: false,
    columnsAreStatuses: false,
    rendersSavedWidgets: false,
    // Start / Stop / Continue by default. These are ordinary BoardColumn rows,
    // so a team that prefers Went well / Didn't / Try next just renames them.
    defaultColumns: [
      { name: "Start", key: "start", color: "#2E7D52", category: "TODO" },
      { name: "Stop", key: "stop", color: "#A32C2C", category: "TODO" },
      { name: "Continue", key: "continue", color: "#C9A227", category: "TODO" },
    ],
  },
};

/**
 * Picker order — how a person scans the list when creating a board, not the
 * enum's declaration order by accident. Delivery boards first, then planning
 * surfaces, then rollups and charts.
 */
export const BOARD_TYPE_ORDER: BoardType[] = [
  BoardType.KANBAN,
  BoardType.SCRUM,
  BoardType.SPRINT_PLANNING,
  BoardType.SPRINT_REVIEW,
  BoardType.BACKLOG,
  BoardType.TABLE,
  BoardType.CALENDAR,
  BoardType.TIMELINE,
  BoardType.ROADMAP,
  BoardType.OKR,
  BoardType.DASHBOARD,
  BoardType.PORTFOLIO,
  BoardType.PROGRAM,
  BoardType.RAID,
  BoardType.CFD,
];

/** Label for a type, falling back to the raw value rather than blank. */
export function boardTypeLabel(type: string): string {
  return BOARD_TYPE_REGISTRY[type as BoardType]?.label ?? type;
}

/** The types "Save as board" may offer, in picker order. */
export function savableFromViewTypes(): BoardType[] {
  return BOARD_TYPE_ORDER.filter((t) => BOARD_TYPE_REGISTRY[t].savableFromView);
}

/**
 * Whether a board of this type would DISPLAY a layout saved by the widget
 * builder. The one gate on offering the builder at all.
 *
 * Case-insensitive on purpose: the column is an enum, so the API payload is
 * upper case, but the type arrives at client components as a plain `string`
 * through several hand-written prop shapes (`board-tabs.tsx`'s `BoardTab`,
 * among others) and a case-sensitive compare would be green against the enum
 * while silently refusing anything that round-tripped through a lower-casing
 * layer. An unknown value answers false — a board type we cannot identify is
 * not one we can promise to draw widgets on.
 */
export function rendersSavedWidgets(type: string): boolean {
  return (
    BOARD_TYPE_REGISTRY[type.toUpperCase() as BoardType]?.rendersSavedWidgets ??
    false
  );
}
