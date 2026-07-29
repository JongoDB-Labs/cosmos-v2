import type { BoardColumn } from "@/types/models";

export function sortColumns(cols: BoardColumn[]): BoardColumn[] {
  return [...cols].sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * The project's status vocabulary, gathered from every board that defines one.
 *
 * Timeline, Calendar, RAID and Roadmap boards are seeded with `columns: []`, and
 * a status is required to create — so a create dialog scoped to one of those
 * boards has no statuses of its own to offer and must borrow the project's.
 * Statuses are deduped by key (boards share them) and the first spelling of a
 * key wins, matching how the Issues view builds the same list from the same rows.
 */
export function projectStatusColumns(
  boards: Array<{ columns?: BoardColumn[] }>,
): BoardColumn[] {
  const byKey = new Map<string, BoardColumn>();
  for (const b of boards) {
    for (const c of b.columns ?? []) if (!byKey.has(c.key)) byKey.set(c.key, c);
  }
  return sortColumns([...byKey.values()]);
}

/**
 * Statuses a create dialog should offer: the board's own workflow when it has
 * one, else the project's. Keeping this in one place means a board that defines
 * no columns can never present an empty, unsubmittable Status picker.
 */
export function createStatusOptions(
  boardColumns: BoardColumn[] | undefined,
  allBoards: Array<{ columns?: BoardColumn[] }>,
): BoardColumn[] {
  const own = sortColumns(boardColumns ?? []);
  return own.length > 0 ? own : projectStatusColumns(allBoards);
}
