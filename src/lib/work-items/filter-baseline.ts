// `BoardFilters` is imported as a TYPE only — erased at build time, so this
// module carries no runtime dependency on the filter-bar component (which
// imports back from here). Same precedent as board-filters.ts.
import type { BoardFilters } from "@/components/boards/shared/filter-bar";

/**
 * "Clear" has to answer a question the empty filter object cannot: unfiltered
 * COMPARED TO WHAT?
 *
 * A plain Kanban board opens showing everything, so its unfiltered view is the
 * empty filter. A Sprint board does not — it opens scoped to its active sprint
 * (`initialIntervalId`), and that scope is the board, not a filter the user
 * applied. Resetting to the empty filter there widens the board to every item in
 * the project, backlog included, and drops the sprint header: the user asks to
 * clear a tag and gets a DIFFERENT board rather than the one they started from.
 *
 * So a board declares its BASELINE — the filter state its unfiltered view is
 * made of — and clearing returns to that.
 */

/**
 * The fields that narrow what the board SHOWS.
 *
 * `swimlaneBy` is deliberately absent. It lives on BoardFilters so it
 * round-trips through the shareable URL, but grouping the same cards into lanes
 * hides nothing — it is presentation (see the "PURE PRESENTATION wrapper" note
 * in kanban-board.tsx). Counting it would make "Clear" offer to undo a view
 * choice the user made on purpose, which is view state clearing must not touch.
 */
const FILTER_KEYS = [
  "search",
  "types",
  "priorities",
  "assigneeId",
  "intervalId",
  "labels",
  "columnKeys",
  "workCategories",
  "createdById",
  "due",
  "milestoneId",
  "blocked",
  "storyPoints",
  "estimate",
  "teamId",
  "customFields",
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];

/** Order-insensitive equality for the multi-select arrays. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Custom-field maps compare by their SET entries only: the filter bar deletes a
 * key on clear but a URL round-trip can leave an empty string behind, and an
 * empty value is inert (see matchesCustomFieldFilters).
 */
function sameCustomFields(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const ea = Object.entries(a ?? {}).filter(([, v]) => v);
  const eb = Object.entries(b ?? {}).filter(([, v]) => v);
  if (ea.length !== eb.length) return false;
  return ea.every(([k, v]) => (b ?? {})[k] === v);
}

function sameField(f: BoardFilters, base: BoardFilters, key: FilterKey): boolean {
  if (key === "customFields") return sameCustomFields(f.customFields, base.customFields);
  const a = f[key];
  const b = base[key];
  if (Array.isArray(a) && Array.isArray(b)) return sameSet(a, b);
  return (a ?? null) === (b ?? null);
}

/**
 * Which filters are actually narrowing the board, measured against its
 * baseline. On a Sprint board whose baseline IS the sprint, a pristine board
 * reports nothing active — so no "Clear" is offered for a scope the user never
 * chose, and the overflow row is not forced open by it.
 */
export function activeFilterKeys(
  filters: BoardFilters,
  baseline: BoardFilters,
): FilterKey[] {
  return FILTER_KEYS.filter((key) => !sameField(filters, baseline, key));
}

/**
 * The filter state "Clear" should produce: every filter back to the board's
 * baseline, and nothing else touched — the grouping the user chose survives,
 * exactly as their scroll position and open columns do.
 */
export function resetToBaseline(
  filters: BoardFilters,
  baseline: BoardFilters,
): BoardFilters {
  return { ...baseline, swimlaneBy: filters.swimlaneBy };
}
