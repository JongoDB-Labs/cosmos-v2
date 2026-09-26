/**
 * Which issues the "Add issues" picker offers when you plan a sprint.
 *
 * Planning inside a Program Increment is two steps: pull the work into PI-1,
 * then deal it out across PI-1's sprints. The picker used to ignore that and
 * list every issue in the project, so the second step meant re-finding the same
 * items in a list that got no smaller — the PI carried no planning weight at
 * all.
 *
 * So a sprint's picker DEFAULTS to its PI's items and can be widened back to
 * the project. Narrowing is a default, never a rule: the scope is computed here
 * and the picker keeps a control to turn it off, because a sprint legitimately
 * takes in work that was never staged on the PI.
 *
 * "The PI's items" means items sitting on the PI interval itself OR on any of
 * its sprints — a PI-1 story parked in Sprint 1 is still PI-1's, and staying
 * visible is what lets a planner move it to Sprint 2.
 *
 * Pure: mirrors `interval-tree.ts`, which does the same one-level PI/sprint
 * grouping for the list view.
 */

/** The minimum an interval must expose to take part in a scope. */
export interface ScopeInterval {
  id: string;
  name: string;
  intervalKind: string;
  /** The Program Increment this sits under, or null for a top-level interval. */
  parentId: string | null;
}

export interface AssignableScope {
  /** The Program Increment the picker narrows to. */
  piId: string;
  /** Its name, for the control that switches the narrowing off. */
  piName: string;
  /** Intervals whose items count as "in this PI" — the PI and its sprints. */
  intervalIds: string[];
}

const PI_KIND = "PROGRAM_INCREMENT";

/**
 * The PI scope for a picker aimed at `target`, or null when nothing narrows it.
 *
 * Null for a PI itself (it has no wider container to narrow against — its own
 * picker is how work gets INTO the PI) and for a standalone sprint, including
 * one whose PI has been deleted: an id that resolves to nothing must not filter
 * the list down to zero issues with no visible cause.
 */
export function assignableScopeFor<T extends ScopeInterval>(
  target: T | null | undefined,
  intervals: T[],
): AssignableScope | null {
  if (!target || target.intervalKind === PI_KIND || !target.parentId) return null;
  const pi = intervals.find(
    (i) => i.id === target.parentId && i.intervalKind === PI_KIND,
  );
  if (!pi) return null;
  return {
    piId: pi.id,
    piName: pi.name,
    intervalIds: [pi.id, ...intervals.filter((i) => i.parentId === pi.id).map((i) => i.id)],
  };
}

/**
 * Keep only the items inside `scope`. A null scope (or a widened picker, which
 * passes null) is the identity — every item stays.
 *
 * Backlog items (`intervalId: null`) are deliberately out of scope: they are
 * exactly the work that has not been staged on the PI yet.
 */
export function narrowToScope<T extends { intervalId: string | null }>(
  items: T[],
  scope: AssignableScope | null,
): T[] {
  if (!scope) return items;
  const ids = new Set(scope.intervalIds);
  return items.filter((i) => i.intervalId !== null && ids.has(i.intervalId));
}
