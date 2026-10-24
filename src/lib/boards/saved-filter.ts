/**
 * A board saved from the Issues view ("Save as board") is that view's query,
 * kept in `Board.config.savedFilter`. It used to be written and never read, so
 * the new board showed every item in the project. This reads it back.
 *
 * The saved filter is the board's SCOPE: what the board is about, like a Table
 * board's `typeKeys`. The filter bar narrows within it, and "Clear" returns to
 * it. It is not shown as filter-bar state because it can hold things the bar
 * has no control for (date ranges, several assignees), and folding only part of
 * it into the bar would quietly widen the board.
 */
import { workItemFilterSchema } from "@/lib/work-items/query/parse";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import {
  evaluable,
  matchesWorkItemFilter,
  type EvaluableItem,
} from "@/lib/work-items/query/evaluate-filter";

export type BoardScope =
  /** No saved filter: every item the board loads is in scope. */
  | { kind: "none" }
  | { kind: "filter"; filter: WorkItemFilter }
  /** A saved filter this board can't apply. The board shows NOTHING rather
   *  than everything, and says why: silently widening is the original bug. */
  | { kind: "invalid"; reason: string };

export function boardScope(config: unknown): BoardScope {
  const raw = config && typeof config === "object" ? (config as Record<string, unknown>).savedFilter : undefined;
  if (raw == null) return { kind: "none" };
  // Checked on the STORED object, before parsing: a parse can drop keys, and a
  // dropped constraint is exactly the silent widening this guards against.
  const check = evaluable(raw as WorkItemFilter);
  if (!check.ok) return { kind: "invalid", reason: `its saved filter uses ${check.reason}` };
  const parsed = workItemFilterSchema.safeParse(raw);
  if (!parsed.success) return { kind: "invalid", reason: "its saved filter is not in a format this board can read" };
  // The board is pinned to its own project; a stored project list is moot.
  const filter: WorkItemFilter = { ...parsed.data };
  delete filter.projectIds;
  return { kind: "filter", filter };
}

export function inBoardScope(scope: BoardScope, item: EvaluableItem): boolean {
  if (scope.kind === "none") return true;
  if (scope.kind === "invalid") return false;
  return matchesWorkItemFilter(item, scope.filter);
}
