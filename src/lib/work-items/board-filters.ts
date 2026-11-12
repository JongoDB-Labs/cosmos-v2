import type { WorkItem, CustomField } from "@/types/models";
import type { BoardFilters } from "@/components/boards/shared/filter-bar";
// bareTypeKey and matchesCustomFieldFilters still live in the filter-bar
// component alongside the filter model itself. Imported rather than duplicated —
// a second copy of "what counts as this type" is exactly the drift this
// extraction exists to end.
import {
  bareTypeKey,
  emptyFilters,
  matchesCustomFieldFilters,
} from "@/components/boards/shared/filter-bar";
import { itemMatchesTeam, type TeamLike } from "@/lib/teams/item-teams";
import { matchesLabelFilter } from "@/lib/work-items/label-filter";
import { matchesOneOf, matchesDuePreset } from "@/lib/work-items/metadata-filters";
import { matchesEstimateBand } from "@/lib/work-items/estimate-filter";
import {
  matchesBlocked,
  matchesMilestone,
  matchesStoryPoints,
} from "@/lib/work-items/relation-filters";

/**
 * A board's UNFILTERED state — what its filter bar should clear back to.
 *
 * A plain Kanban opens showing everything, so that is the empty filter. A Sprint
 * board opens scoped to a sprint (`initialIntervalId`), and that scope is the
 * board itself rather than something the user applied — so clearing a tag there
 * has to leave it in place. See lib/work-items/filter-baseline for what "Clear"
 * then does with it.
 */
export function boardBaseline(initialIntervalId?: string | null): BoardFilters {
  return initialIntervalId
    ? { ...emptyFilters, intervalId: initialIntervalId }
    : emptyFilters;
}

/**
 * Does an item's interval satisfy an interval selection?
 *
 * A sprint selection is an exact match, as it always was. A Program Increment
 * selection means "any sprint under this PI" — work items carry a SPRINT id and
 * never a PI id, so comparing a PI selection directly against `item.intervalId`
 * matched nothing and emptied the board (3d90c48e). An empty board reads as
 * "nothing matched" rather than "this control is broken", which is why this went
 * unnoticed: the Interval dropdown is fed the project's whole interval list, PIs
 * included, with no `intervalKind` filter anywhere between the API and the select.
 *
 * `children` absent => exact match only. The rollup is opt-in per call site so a
 * board that has not resolved the hierarchy keeps today's behaviour instead of
 * inheriting a half-wired widening.
 */
function inIntervalSelection(
  itemIntervalId: string | null,
  selected: string,
  children?: Map<string, Set<string>>,
): boolean {
  if (itemIntervalId === selected) return true;
  if (!itemIntervalId) return false; // backlog item: in no interval, so in no PI
  return children?.get(selected)?.has(itemIntervalId) ?? false;
}

/**
 * Does one work item satisfy a board's filters?
 *
 * This lived inside timeline-view.tsx, so any other board wanting it would have
 * had to import the entire Gantt component — which is why Kanban grew its own
 * 61-line copy instead, and why the five remaining board types had no filtering
 * at all. One predicate in one place is the point: a filter that behaves
 * differently depending on which board you are looking at is worse than no
 * filter.
 *
 * Every parameter past the first two is optional, so a board with no custom
 * fields, teams or relation data still gets search, type, priority, assignee,
 * interval and status by calling `matchesFilters(item, filters)`.
 *
 * `BoardFilters` is imported as a TYPE from the filter-bar component — erased at
 * build time, so this creates no runtime dependency on a component.
 */
export function matchesFilters(
  item: WorkItem,
  f: BoardFilters,
  defs: CustomField[] = [],
  /**
   * userId → their teams. Optional so existing callers are unaffected; without
   * it the team filter is inert rather than silently hiding everything.
   */
  teamsByUserId: Map<string, TeamLike[]> = new Map(),
  /** One instant for the whole pass — see the Kanban note. */
  now: Date = new Date(),
  /**
   * Relation-derived lookups, pre-resolved by the caller. An options bag rather
   * than a seventh positional parameter, which is where argument-order bugs live.
   */
  rel: {
    blocked?: Set<string>;
    milestones?: Map<string, Set<string>>;
    /**
     * Program Increment id -> the ids of the sprints under it. Lets an interval
     * selection name a PI and still match work, which links to a SPRINT and
     * never to a PI. Optional: without it the interval clause is the exact
     * match it has always been, so no existing caller is silently widened.
     */
    intervalChildren?: Map<string, Set<string>>;
  } = {},
): boolean {
  if (
    f.search &&
    !item.title.toLowerCase().includes(f.search.toLowerCase()) &&
    !String(item.ticketNumber).includes(f.search)
  )
    return false;
  if (f.types.length > 0 && !f.types.includes(bareTypeKey(item.workItemType?.key)))
    return false;
  if (f.priorities.length > 0 && !f.priorities.includes(item.priority)) return false;
  // Multi-assign: match the primary OR any member of the assignee set.
  if (
    f.assigneeId &&
    item.assigneeId !== f.assigneeId &&
    !item.assignees?.some((a) => a.userId === f.assigneeId)
  )
    return false;
  if (f.intervalId && !inIntervalSelection(item.intervalId, f.intervalId, rel.intervalChildren))
    return false;
  // The item's own team, else whatever teams its assignee is on.
  if (!itemMatchesTeam(item, f.teamId, teamsByUserId)) return false;
  if (!matchesLabelFilter(item.tags, f.labels)) return false;
  if (!matchesOneOf(item.columnKey, f.columnKeys)) return false;
  if (!matchesOneOf(item.workCategory, f.workCategories)) return false;
  if (f.createdById && item.createdById !== f.createdById) return false;
  if (!matchesDuePreset(item.dueDate, f.due, now)) return false;
  if (!matchesMilestone(item.id, f.milestoneId, rel.milestones ?? new Map())) return false;
  if (!matchesBlocked(item.id, f.blocked, rel.blocked ?? new Set())) return false;
  if (!matchesStoryPoints(item.storyPoints, f.storyPoints)) return false;
  if (!matchesEstimateBand(item.originalEstimate, f.estimate)) return false;
  if (!matchesCustomFieldFilters(item.customFields, f.customFields, defs)) return false;
  return true;
}
