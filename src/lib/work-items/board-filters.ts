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
 * The tags to offer in a board's tag (label) filter menu.
 *
 * Derived from the cards the board is CURRENTLY showing, not from every item the
 * project has ever had. That distinction is the whole point on a Sprint board:
 * it loads the project's full item list and then scopes itself to one sprint, so
 * a menu built from the raw list offers tags that only exist in another sprint
 * or in the backlog — pick one and the board goes blank. Tags you can select are
 * now tags some visible card actually carries.
 *
 * The label clause itself is excluded from that pass, deliberately: with it
 * applied, selecting one tag would collapse the menu to that tag alone and there
 * would be no way to add a second. Selecting more tags has to keep widening the
 * result (OR), so the options have to be computed as if nothing were selected.
 *
 * An active selection is always kept in the list even if nothing on screen
 * carries it any more, so it stays removable — the same rule `presentTypeKeys`
 * follows in the filter bar.
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
  const inScope = items.filter((item) =>
    matchesFilters(item, withoutLabels, defs, teamsByUserId, now, rel),
  );
  const options = new Set(presentLabels(inScope));
  for (const selected of f.labels) if (selected) options.add(selected);
  return [...options].sort((a, b) => a.localeCompare(b));
}
