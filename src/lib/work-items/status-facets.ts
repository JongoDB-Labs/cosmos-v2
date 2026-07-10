/**
 * Group a project's board columns into per-project inline-status options for the
 * org-wide Issues view.
 *
 * A work item's `columnKey` is a project-scoped board lane, so the cross-project
 * Issues list can only offer a *valid* inline status change (COSMOS-30) by
 * restricting the options to the lanes that exist in THAT item's project. A
 * global union of every project's statuses would let a user pick a lane the
 * item's own board doesn't have — an invalid transition the PUT wouldn't catch.
 *
 * Deduped by key within a project (the same key can recur across a project's
 * several boards); callers pass the rows already ordered by `sortOrder`, so the
 * first-seen — i.e. lowest sortOrder — name/category is kept as the label.
 */

export interface ColumnFacetRow {
  key: string;
  name: string;
  category: string;
  board: { projectId: string };
}

export interface StatusOption {
  key: string;
  name: string;
  category: string;
}

export function groupStatusesByProject(
  columns: readonly ColumnFacetRow[],
): Record<string, StatusOption[]> {
  const byProject: Record<string, StatusOption[]> = {};
  const seen = new Map<string, Set<string>>();
  for (const c of columns) {
    const pid = c.board.projectId;
    let keys = seen.get(pid);
    if (!keys) {
      keys = new Set();
      seen.set(pid, keys);
      byProject[pid] = [];
    }
    if (keys.has(c.key)) continue;
    keys.add(c.key);
    byProject[pid].push({ key: c.key, name: c.name, category: c.category });
  }
  return byProject;
}
