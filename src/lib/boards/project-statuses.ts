/**
 * The statuses a project's work can be in, for the Status filter.
 *
 * `work_items.column_key` is a PROJECT-level workflow value — an item has one
 * status wherever it is looked at. The filter, though, took its options from
 * the CURRENT board's own `BoardColumn` rows, and board creation seeds none. So
 * a Timeline, Roadmap or Calendar board owned zero columns, the control's
 * `boardColumns.length > 0` guard failed, and Status could not be filtered on
 * at all outside the boards that happen to own columns.
 *
 * Unioning across the project's boards puts the options back where they belong.
 * The caller passes boards it has ALREADY fetched and which are already
 * team-narrowed by the boards endpoint, so this adds no request and cannot widen
 * what a viewer can see.
 */

export interface StatusColumn {
  key: string;
  name: string;
  sortOrder: number;
  category?: string;
}

export function projectStatusColumns(
  boards: { columns?: StatusColumn[] | null }[]
): StatusColumn[] {
  const byKey = new Map<string, StatusColumn>();

  for (const board of boards) {
    for (const column of board.columns ?? []) {
      // First name wins. Two boards may label the same key differently ("To Do"
      // vs "Backlog"); picking per-board would make the filter's own labels
      // change depending on which board you opened it from.
      if (!byKey.has(column.key)) byKey.set(column.key, column);
    }
  }

  // Workflow order, not discovery order — a list showing Done above To Do reads
  // as broken even when the filtering behind it is correct.
  return [...byKey.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}
