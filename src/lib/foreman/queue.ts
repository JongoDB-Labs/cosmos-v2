export interface QueueItem {
  id: string;
  ticketNumber: number;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  columnKey: string;
  columnEnteredAt: string; // ISO
}

/** Columns that count as "ready to build". */
export const TODO_KEYS = new Set(["backlog", "todo"]);

const RANK: Record<QueueItem["priority"], number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/** Column tier: To-do is the planned up-next queue and claims first; backlog is
 *  the fallback pool, only surfaced once To-do is empty. */
const TIER: Record<string, number> = { todo: 0, backlog: 1 };

/** Next ticket to work: only TODO-column items, To-do tier before backlog tier,
 *  highest priority first within a tier, then FIFO. */
export function pickNext(items: QueueItem[]): QueueItem | null {
  const todo = items.filter((i) => TODO_KEYS.has(i.columnKey));
  if (todo.length === 0) return null;
  return [...todo].sort(
    (a, b) =>
      (TIER[a.columnKey] ?? 1) - (TIER[b.columnKey] ?? 1) ||
      RANK[a.priority] - RANK[b.priority] ||
      Date.parse(a.columnEnteredAt) - Date.parse(b.columnEnteredAt),
  )[0];
}
