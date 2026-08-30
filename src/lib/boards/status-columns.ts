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
 * The workflow to offer when NOTHING in the project defines one (COSMOS-168).
 *
 * `projectStatusColumns` above deliberately reports an honest empty, but a
 * PICKER cannot: an empty Status control reads as broken, and the create dialog
 * already writes `columnKey: "backlog"` when its list never loaded — so the item
 * silently lands in Backlog and the control that should have said otherwise has
 * nothing in it. That is the reported "always defaults to backlog, and I can't
 * change it" on the Timeline/Gantt, whose boards own no columns of their own.
 *
 * These are the same five the project-create route seeds (`DEFAULT_COLUMNS`),
 * starting at the key the fallback already writes, so offering them tells the
 * truth about where the item is going instead of inventing a new vocabulary.
 * `columnKey` is stored verbatim, so a pick here is as real as any other.
 */
export const FALLBACK_STATUS_COLUMNS: BoardColumn[] = [
  { id: "fallback-backlog", boardId: "", name: "Backlog", key: "backlog", color: "#94a3b8", wipLimit: null, sortOrder: 0, category: "TODO" },
  { id: "fallback-todo", boardId: "", name: "To Do", key: "todo", color: "#60a5fa", wipLimit: null, sortOrder: 1, category: "TODO" },
  { id: "fallback-in-progress", boardId: "", name: "In Progress", key: "in-progress", color: "#fbbf24", wipLimit: null, sortOrder: 2, category: "IN_PROGRESS" },
  { id: "fallback-review", boardId: "", name: "Review", key: "review", color: "#a78bfa", wipLimit: null, sortOrder: 3, category: "IN_PROGRESS" },
  { id: "fallback-done", boardId: "", name: "Done", key: "done", color: "#34d399", wipLimit: null, sortOrder: 4, category: "DONE" },
];

/**
 * Statuses a create dialog should offer: the board's own workflow when it has
 * one, else the project's, else the fallback. Keeping this in one place means a
 * board that defines no columns can never present an empty, unsubmittable
 * Status picker.
 */
export function createStatusOptions(
  boardColumns: BoardColumn[] | undefined,
  allBoards: Array<{ columns?: BoardColumn[] }>,
): BoardColumn[] {
  const own = sortColumns(boardColumns ?? []);
  if (own.length > 0) return own;
  const pooled = projectStatusColumns(allBoards);
  return pooled.length > 0 ? pooled : FALLBACK_STATUS_COLUMNS;
}

/** Anything a Status control can render — the two fields every picker reads. */
export interface StatusOption {
  key: string;
  name: string;
}

/**
 * Statuses the detail sheet should offer when EDITING an item's status: the
 * project's pooled workflow, else the current board's own columns, else the
 * fallback above.
 *
 * The board's columns are a real second chance, not decoration: the sheet used
 * to write `statusColumns ?? columns`, and every caller that pools the project's
 * statuses passes an ARRAY — empty while the boards request is in flight, and
 * empty again if it fails — so `??` never fired and the board's own workflow,
 * sitting right there, was never consulted.
 */
export function editStatusOptions(
  projectColumns: StatusOption[] | undefined,
  boardColumns: StatusOption[] | undefined,
): StatusOption[] {
  if (projectColumns?.length) return projectColumns;
  if (boardColumns?.length) return boardColumns;
  return FALLBACK_STATUS_COLUMNS;
}
