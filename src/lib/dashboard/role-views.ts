/**
 * Which panels a given role sees on Sprint Health, and at which scope.
 *
 * WHY A VIEW MODEL RATHER THAN A FILTER. A preset that merely reorders a fixed
 * set of panels is decoration: everyone still scrolls past everyone else's
 * charts, and the board still answers no one's question first. These presets
 * SELECT — an RTE opening the board sees increment-level flow and predictability
 * and does not see one team's workload split; a Scrum Master sees the sprint in
 * flight and the impediments in it and does not see cross-team PI rollup. The
 * panel a role does not need is absent, not demoted.
 *
 * SCOPE IS PART OF THE MODEL, not a UI toggle bolted on. Several panels are only
 * meaningful at one level — a burndown of a Program Increment is a chart of a
 * container that holds no work of its own, and "sprint contribution to the PI"
 * is meaningless when looking at a single sprint. Declaring scope per panel is
 * what lets one "Across time" tab serve both without showing either a lie.
 *
 * HONESTY IS DECLARED, NOT LEFT TO THE RENDERER. `minCompletedIntervals` states
 * what a panel needs before it can say anything true. Two completed sprints do
 * not make a trend and three points do not make a control chart; a panel that
 * draws them anyway invites a decision the data cannot support. The renderer is
 * expected to show the shortfall — "needs 5 completed sprints, has 1" — rather
 * than an empty axis, which reads as a bug or, worse, as zero.
 */

export type PanelScope = "sprint" | "pi" | "both";

export type PanelId =
  // Flow and progress
  | "burndown"
  | "burnup"
  | "cumulative-flow"
  // Delivery over time
  | "velocity-trend"
  | "predictability"
  | "throughput"
  | "cycle-time"
  // Commitment and change
  | "commitment-vs-completed"
  | "scope-change"
  | "carryover"
  // Composition
  | "status-mix"
  | "priority-mix"
  | "work-type-mix"
  | "workload"
  // Increment level
  | "pi-progress"
  | "pi-objectives"
  | "sprint-contribution"
  // Narrative
  | "impediments"
  | "activity";

export interface PanelDef {
  id: PanelId;
  title: string;
  /** The question this panel exists to answer, in the reader's words. */
  question: string;
  scope: PanelScope;
  /**
   * Completed intervals required before the panel can state anything. 0 means it
   * describes the interval in flight and needs no history.
   */
  minCompletedIntervals: number;
}

export const PANELS: Record<PanelId, PanelDef> = {
  burndown: {
    id: "burndown",
    title: "Burndown",
    question: "Will the work in this sprint be finished by the end of it?",
    scope: "sprint",
    minCompletedIntervals: 0,
  },
  burnup: {
    id: "burnup",
    title: "Burnup",
    question: "How much is done, and is the target moving away from us?",
    scope: "both",
    minCompletedIntervals: 0,
  },
  "cumulative-flow": {
    id: "cumulative-flow",
    title: "Cumulative flow",
    question: "Where is work piling up between started and finished?",
    scope: "both",
    minCompletedIntervals: 0,
  },
  "velocity-trend": {
    id: "velocity-trend",
    title: "Velocity",
    question: "Are we delivering more, less, or about the same as before?",
    // Two points make a line, not a trend; the third is what distinguishes a
    // direction from a pair of numbers.
    scope: "both",
    minCompletedIntervals: 3,
  },
  predictability: {
    id: "predictability",
    title: "Predictability",
    question: "Can we be relied on to deliver what we forecast?",
    // Spread is what this measures, and spread over fewer than five samples is
    // dominated by whichever sprint had a holiday in it.
    scope: "both",
    minCompletedIntervals: 5,
  },
  throughput: {
    id: "throughput",
    title: "Throughput",
    question: "How many items are we finishing per sprint?",
    scope: "both",
    minCompletedIntervals: 3,
  },
  "cycle-time": {
    id: "cycle-time",
    title: "Cycle time",
    question: "Once we start something, how long until it is done?",
    scope: "both",
    minCompletedIntervals: 1,
  },
  "commitment-vs-completed": {
    id: "commitment-vs-completed",
    title: "Committed vs completed",
    question: "Did we finish what we said we would at planning?",
    scope: "both",
    minCompletedIntervals: 1,
  },
  "scope-change": {
    id: "scope-change",
    title: "Scope change",
    question: "What was added or removed after the sprint started?",
    scope: "both",
    minCompletedIntervals: 0,
  },
  carryover: {
    id: "carryover",
    title: "Carryover",
    question: "What keeps rolling from one sprint into the next?",
    scope: "both",
    minCompletedIntervals: 1,
  },
  "status-mix": {
    id: "status-mix",
    title: "Status mix",
    question: "Where does the work stand right now?",
    scope: "both",
    minCompletedIntervals: 0,
  },
  "priority-mix": {
    id: "priority-mix",
    title: "Priority mix",
    question: "Are we working on the important things?",
    scope: "both",
    minCompletedIntervals: 0,
  },
  "work-type-mix": {
    id: "work-type-mix",
    title: "Work type mix",
    question: "How much of our capacity goes to features versus debt and defects?",
    scope: "both",
    minCompletedIntervals: 0,
  },
  workload: {
    id: "workload",
    title: "Workload",
    question: "Is the work spread sensibly across the team?",
    scope: "sprint",
    minCompletedIntervals: 0,
  },
  "pi-progress": {
    id: "pi-progress",
    title: "Increment progress",
    question: "Is the increment on track at the current rate?",
    scope: "pi",
    minCompletedIntervals: 0,
  },
  "pi-objectives": {
    id: "pi-objectives",
    title: "Objectives",
    question: "Which increment objectives are met, at risk, or missed?",
    scope: "pi",
    minCompletedIntervals: 0,
  },
  "sprint-contribution": {
    id: "sprint-contribution",
    title: "Sprint contribution",
    question: "Which sprints delivered the increment's work?",
    scope: "pi",
    minCompletedIntervals: 1,
  },
  impediments: {
    id: "impediments",
    title: "Blocked work",
    question: "What is stuck, and for how long?",
    scope: "both",
    minCompletedIntervals: 0,
  },
  activity: {
    id: "activity",
    title: "Recent activity",
    question: "What has actually been happening?",
    scope: "both",
    minCompletedIntervals: 0,
  },
};

export type RoleKey =
  | "scrum-master"
  | "product-owner"
  | "rte"
  | "product-manager"
  | "everything";

export interface RoleView {
  key: RoleKey;
  label: string;
  /** Why this set — so a reader can tell whether they are in the right view. */
  description: string;
  /** Ordered: the first panel is the one this role opens the board to read. */
  panels: PanelId[];
}

export const ROLE_VIEWS: RoleView[] = [
  {
    key: "scrum-master",
    label: "Scrum Master",
    description:
      "The sprint in flight and what is getting in its way — flow, blockers, scope moving under the team, and how the load is spread.",
    panels: [
      "burndown",
      "impediments",
      "scope-change",
      "cumulative-flow",
      "workload",
      "carryover",
      "status-mix",
      "activity",
    ],
  },
  {
    key: "product-owner",
    label: "Product Owner",
    description:
      "What is being delivered and whether it is the right work — commitment kept, priority mix, and what changed after planning.",
    panels: [
      "commitment-vs-completed",
      "burnup",
      "priority-mix",
      "work-type-mix",
      "scope-change",
      "throughput",
      "status-mix",
    ],
  },
  {
    key: "rte",
    label: "RTE",
    description:
      "The increment as a whole — objectives, progress against the PI, which sprints delivered it, and whether the trains can be relied on.",
    panels: [
      "pi-progress",
      "pi-objectives",
      "sprint-contribution",
      "predictability",
      "velocity-trend",
      "scope-change",
      "impediments",
    ],
  },
  {
    key: "product-manager",
    label: "Product Manager",
    description:
      "Delivery over time rather than the sprint in flight — rate, reliability, cycle time and where capacity is going.",
    panels: [
      "velocity-trend",
      "throughput",
      "cycle-time",
      "predictability",
      "work-type-mix",
      "burnup",
      "pi-progress",
    ],
  },
  {
    key: "everything",
    label: "Everything",
    description: "Every panel this scope supports, in a fixed order. The escape hatch when a preset hides what you came for.",
    // Deliberately derived at call time, so a new panel appears here without
    // anyone remembering to add it — the one list that must never go stale.
    panels: [],
  },
];

/** Panels valid at `scope`, in `PANELS` declaration order. */
export function panelsForScope(scope: "sprint" | "pi"): PanelDef[] {
  return Object.values(PANELS).filter((p) => p.scope === scope || p.scope === "both");
}

/**
 * The ordered panels a role sees at a scope.
 *
 * A role's list is filtered by scope rather than duplicated per scope: the same
 * RTE view at sprint scope simply drops the increment-only panels instead of
 * needing a second hand-maintained list that will drift from the first.
 *
 * "Everything" is derived, never enumerated — a hand-written "all panels" list
 * is the one that silently goes stale the first time someone adds a panel.
 */
export function panelsForRole(role: RoleKey, scope: "sprint" | "pi"): PanelDef[] {
  const valid = panelsForScope(scope);
  if (role === "everything") return valid;

  const view = ROLE_VIEWS.find((v) => v.key === role);
  if (!view) return valid;

  const byId = new Map(valid.map((p) => [p.id, p]));
  return view.panels.map((id) => byId.get(id)).filter((p): p is PanelDef => p !== undefined);
}

export interface PanelAvailability {
  panel: PanelDef;
  /** False when the panel cannot yet state anything true. */
  ready: boolean;
  /** Present when not ready — what it needs, and what exists. */
  shortfall?: { needs: number; has: number };
}

/**
 * Whether each panel can say anything yet, given how much history exists.
 *
 * Returned rather than filtered out on purpose: a reader who cannot find
 * "Predictability" does not learn that it needs five sprints, they conclude the
 * product does not have it. The panel stays, and states its own shortfall.
 */
export function panelAvailability(
  panels: PanelDef[],
  completedIntervals: number,
): PanelAvailability[] {
  return panels.map((panel) =>
    completedIntervals >= panel.minCompletedIntervals
      ? { panel, ready: true }
      : {
          panel,
          ready: false,
          shortfall: { needs: panel.minCompletedIntervals, has: completedIntervals },
        },
  );
}
