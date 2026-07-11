import type { BoardColumn } from "@/types/models";

/** The minimal shape the create helpers need off a work-item type. */
export interface CreateTypeOption {
  id: string;
  key: string;
  name: string;
}

/**
 * Pick the work-item type appropriate for a new card created from a board's
 * right-click menu: the project's "task" type when present (built-in keys are
 * sector-prefixed, e.g. `software.task`; custom ones may be the bare `task`),
 * else the first available type. Returns "" while the org's types are still
 * loading/empty — the caller then falls back to the server-resolved bare TASK
 * type so a create never silently no-ops. Mirrors the `defaultTypeId` used by
 * the per-column quick-create and the New-issue dialog so every create surface
 * defaults consistently.
 */
export function defaultBoardTypeId(types: CreateTypeOption[]): string {
  if (types.length === 0) return "";
  const task = types.find((t) => t.key === "task" || t.key.endsWith(".task"));
  return (task ?? types[0]).id;
}

/**
 * Label for a board's right-click "create" action, e.g. `New task`. Uses the
 * name of the appropriate default type (see {@link defaultBoardTypeId}) so the
 * menu reflects "the item type appropriate for the current board" — falling
 * back to a generic "New issue" before the types load.
 */
export function createActionLabel(types: CreateTypeOption[]): string {
  const id = defaultBoardTypeId(types);
  const type = types.find((t) => t.id === id);
  return type ? `New ${type.name.toLowerCase()}` : "New issue";
}

/**
 * Resolve which column a right-click create should target. A right-click on a
 * specific column pre-scopes to it; a right-click on the empty board background
 * falls back to the board's first column (columns are pre-sorted by sortOrder).
 * Returns "" when the board has no columns, which keeps the create action
 * disabled rather than posting an item with no status.
 */
export function resolveTargetColumnKey(
  columns: BoardColumn[],
  preferredKey?: string | null,
): string {
  if (preferredKey && columns.some((c) => c.key === preferredKey)) {
    return preferredKey;
  }
  return columns[0]?.key ?? "";
}
