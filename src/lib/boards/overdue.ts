/**
 * Overdue (late / slipping) detection for work items on the interactive Gantt /
 * Timeline.
 *
 * A work item is "overdue" when it has a planned end date (`dueDate`) that is
 * already in the past AND it is not yet resolved — i.e. it's neither completed
 * nor sitting in a terminal (DONE / CANCELLED) board column. A cancelled item
 * isn't "missing the mark", so it's excluded alongside completed work.
 *
 * Kept as a pure, unit-testable helper so the SAME rule drives the Gantt's
 * Overdue filter, the row highlight, the count badge, and the tooltip — and so
 * any other view can reuse it. `now` is injected for deterministic tests and
 * defaults to the current time, which is what makes the view reflect real-time
 * slippage as dates pass and items complete.
 */
import type { WorkItem } from "@/types/models";

export function isWorkItemOverdue(
  item: Pick<WorkItem, "dueDate" | "completedAt" | "columnKey">,
  resolvedKeys: ReadonlySet<string>,
  now: number = Date.now(),
): boolean {
  if (item.completedAt) return false;
  if (resolvedKeys.has(item.columnKey)) return false;
  if (!item.dueDate) return false;
  return new Date(item.dueDate).getTime() < now;
}
