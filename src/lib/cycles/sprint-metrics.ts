/**
 * Pure sprint/cycle planning + retrospective math, shared by the server
 * complete route (post-hoc report) and the client review + planning dialogs
 * (live preview). Keeping it pure and dependency-free makes it unit-testable
 * and guarantees the "review" preview a user sees before finalizing matches the
 * report the server persists on completion.
 */

const MS_PER_DAY = 86_400_000;

/** A column is "done" if its key mentions done/completed/closed — the same
 *  heuristic the complete route uses to split finished vs carried-over work. */
const DONE_KEYS = ["done", "completed", "closed"] as const;

export function isDoneColumn(columnKey: string): boolean {
  const k = columnKey.toLowerCase();
  return DONE_KEYS.some((d) => k.includes(d));
}

export interface SprintItemInput {
  storyPoints?: number | null;
  columnKey: string;
  priority?: string | null;
}

export interface SprintMetricsInput {
  items: SprintItemInput[];
  startDate: string | Date;
  endDate: string | Date;
  /** Point in time to evaluate progress against. Defaults to `new Date()`. */
  asOf?: Date;
}

export type SprintPacing = "ahead" | "on-track" | "behind";

export interface SprintMetrics {
  totalItems: number;
  completedItems: number;
  incompleteItems: number;
  totalStoryPoints: number;
  completedStoryPoints: number;
  /** Story points delivered — the sprint's velocity. */
  velocity: number;
  /** Fraction 0..1 of items finished. */
  itemCompletionRate: number;
  /** Fraction 0..1 of story points finished — the sprint's efficiency. */
  pointCompletionRate: number;
  totalDays: number;
  elapsedDays: number;
  remainingDays: number;
  /** Story points delivered per elapsed day so far. */
  burnRate: number;
  /** Even pace needed to burn all scope across the whole sprint. */
  idealBurnRate: number;
  /** Points that "should" be done by `asOf` on an even burn. */
  expectedCompletedByNow: number;
  /** completedStoryPoints − expectedCompletedByNow; >0 = ahead of schedule. */
  pacingDelta: number;
  pacing: SprintPacing;
  /** Pace (points/day) needed over the remaining days to clear the backlog. */
  requiredBurnRate: number;
  itemsByPriority: Record<string, number>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Compute burn/pacing/efficiency metrics for a cycle's work items. Works both
 *  mid-sprint (live review preview) and at completion (final report). */
export function computeSprintMetrics(input: SprintMetricsInput): SprintMetrics {
  const { items } = input;
  const start = new Date(input.startDate).getTime();
  const end = new Date(input.endDate).getTime();
  const asOf = (input.asOf ?? new Date()).getTime();

  const done = items.filter((i) => isDoneColumn(i.columnKey));
  const totalItems = items.length;
  const completedItems = done.length;
  const incompleteItems = totalItems - completedItems;

  const totalStoryPoints = items.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
  const completedStoryPoints = done.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
  const remainingStoryPoints = totalStoryPoints - completedStoryPoints;

  const itemCompletionRate = totalItems > 0 ? round2(completedItems / totalItems) : 0;
  const pointCompletionRate =
    totalStoryPoints > 0 ? round2(completedStoryPoints / totalStoryPoints) : 0;

  const totalDays = Math.max(0, (end - start) / MS_PER_DAY);
  const rawElapsed = (asOf - start) / MS_PER_DAY;
  const elapsedDays =
    totalDays > 0 ? Math.min(Math.max(rawElapsed, 0), totalDays) : Math.max(rawElapsed, 0);
  const remainingDays = Math.max(0, totalDays - elapsedDays);

  const burnRate = elapsedDays > 0 ? round2(completedStoryPoints / elapsedDays) : 0;
  const idealBurnRate = totalDays > 0 ? round2(totalStoryPoints / totalDays) : 0;
  const expectedCompletedByNow =
    totalDays > 0 ? round2(totalStoryPoints * (elapsedDays / totalDays)) : 0;
  const pacingDelta = round2(completedStoryPoints - expectedCompletedByNow);

  // Half a point of slack keeps trivially-close sprints from flapping labels.
  let pacing: SprintPacing = "on-track";
  if (pacingDelta > 0.5) pacing = "ahead";
  else if (pacingDelta < -0.5) pacing = "behind";

  const requiredBurnRate =
    remainingDays > 0 ? round2(remainingStoryPoints / remainingDays) : remainingStoryPoints;

  const itemsByPriority = items.reduce<Record<string, number>>((acc, i) => {
    if (i.priority) acc[i.priority] = (acc[i.priority] ?? 0) + 1;
    return acc;
  }, {});

  return {
    totalItems,
    completedItems,
    incompleteItems,
    totalStoryPoints,
    completedStoryPoints,
    velocity: completedStoryPoints,
    itemCompletionRate,
    pointCompletionRate,
    totalDays: round2(totalDays),
    elapsedDays: round2(elapsedDays),
    remainingDays: round2(remainingDays),
    burnRate,
    idealBurnRate,
    expectedCompletedByNow,
    pacingDelta,
    pacing,
    requiredBurnRate,
    itemsByPriority,
  };
}

export interface SprintLike {
  name: string;
  startDate: string | Date;
  endDate: string | Date;
  cycleKind?: string;
  parentId?: string | null;
}

export interface NextSprintSuggestion {
  name: string;
  startDate: string; // ISO
  endDate: string; // ISO
  cycleKind: string;
  parentId: string | null;
  durationDays: number;
}

/** Increment the trailing iteration number in a sprint name.
 *  "Sprint 1" → "Sprint 2"; "Two-week Sprint 12" → "Two-week Sprint 13";
 *  a name with no number gets " 2" appended ("Hardening" → "Hardening 2"). */
export function incrementSprintName(name: string): string {
  const trimmed = name.trim();
  const match = trimmed.match(/(\d+)(\D*)$/);
  if (!match) return `${trimmed} 2`;
  const [, digits, tail] = match;
  const next = String(Number(digits) + 1);
  return trimmed.slice(0, match.index) + next + tail;
}

/** Propose the next sprint after `cycle` completes: an incremented title, the
 *  same duration, starting the day after the prior sprint ends. Drives the
 *  post-completion "start the next sprint?" roll-over dialog. */
export function suggestNextSprint(cycle: SprintLike): NextSprintSuggestion {
  const start = new Date(cycle.startDate).getTime();
  const end = new Date(cycle.endDate).getTime();
  const durationMs = Math.max(0, end - start);

  // Back-to-back: the next sprint opens the day after this one closes.
  const nextStart = end + MS_PER_DAY;
  const nextEnd = nextStart + durationMs;

  return {
    name: incrementSprintName(cycle.name),
    startDate: new Date(nextStart).toISOString(),
    endDate: new Date(nextEnd).toISOString(),
    cycleKind: cycle.cycleKind ?? "SPRINT",
    parentId: cycle.parentId ?? null,
    durationDays: Math.round(durationMs / MS_PER_DAY),
  };
}
