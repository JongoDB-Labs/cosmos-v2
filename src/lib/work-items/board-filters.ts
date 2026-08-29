import type { WorkItem, CustomField } from "@/types/models";
import type { BoardFilters } from "@/components/boards/shared/filter-bar";
// bareTypeKey and matchesCustomFieldFilters still live in the filter-bar
// component alongside the filter model itself. Imported rather than duplicated —
// a second copy of "what counts as this type" is exactly the drift this
// extraction exists to end.
import {
  bareTypeKey,
  matchesCustomFieldFilters,
} from "@/components/boards/shared/filter-bar";
import { itemMatchesTeam, type TeamLike } from "@/lib/teams/item-teams";
import { matchesLabelFilter, presentLabels } from "@/lib/work-items/label-filter";
import { matchesOneOf, matchesDuePreset } from "@/lib/work-items/metadata-filters";
import { matchesEstimateBand } from "@/lib/work-items/estimate-filter";
import {
  matchesBlocked,
  matchesMilestone,
  matchesStoryPoints,
} from "@/lib/work-items/relation-filters";

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
  if (f.intervalId && item.intervalId !== f.intervalId) return false;
  // A team's work is what its members are assigned; an item can match several.
  if (!itemMatchesTeam(item.assigneeId, f.teamId, teamsByUserId)) return false;
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

/**
 * The tags a board should OFFER in its tag (Label) filter control.
 *
 * "Available tags" has to mean available ON THIS BOARD. `presentLabels(items)`
 * over the raw fetch does not, on any board that scopes itself before the user
 * touches a filter: a Kanban fetches the project's ENTIRE item list and narrows
 * it in the client, and a SCRUM board is that same component seeded with the
 * active sprint via `initialIntervalId`. So the menu was listing tags carried
 * only by cards in other sprints or in the backlog. Pick one of those and every
 * card disappears with nothing on screen saying why — the empty-board-for-an-
 * invisible-reason failure the filter bar's "an active filter is never hidden"
 * rule exists to prevent.
 *
 * So the options come from the cards the board is actually showing. Two details
 * carry the behaviour:
 *
 *  - Every clause is applied EXCEPT the label clause itself. Applying it would
 *    collapse the menu to the tags already selected the moment one is ticked,
 *    making a second tag unselectable — and the tags combine as OR, so picking
 *    more than one is the point (see `matchesLabelFilter`).
 *  - Any active selection stays listed even if it now matches nothing, so it
 *    remains removable. Same rule `shownTypeOptions` follows for Type.
 *
 * Arguments mirror `matchesFilters` so a caller passes through what it already
 * computed for the filtering pass.
 */
export function tagFilterOptions(
  items: WorkItem[],
  f: BoardFilters,
  defs: CustomField[] = [],
  teamsByUserId: Map<string, TeamLike[]> = new Map(),
  now: Date = new Date(),
  rel: {
    blocked?: Set<string>;
    milestones?: Map<string, Set<string>>;
  } = {},
): string[] {
  const withoutLabels = { ...f, labels: [] };
  const scoped = items.filter((item) =>
    matchesFilters(item, withoutLabels, defs, teamsByUserId, now, rel),
  );
  const options = new Set(presentLabels(scoped));
  for (const tag of f.labels) options.add(tag);
  return [...options].sort((a, b) => a.localeCompare(b));
}
