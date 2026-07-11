import type { WorkItem } from "@/types/models";

/**
 * Assignee-workload aggregation + drill-down helpers for the Sprint Dashboard.
 *
 * Both the "Assignee Workload" bar chart and its drill-down (clicking a bar to
 * see that person's tickets) must agree on how an item maps to an assignee
 * bucket. They share `assigneeLabel` here so the bucket label a user clicks and
 * the filter that lists the underlying tickets can never drift apart.
 */

type AssignedItem = Pick<WorkItem, "assigneeId">;

/**
 * The workload-bucket label for an item, using the member map (userId →
 * display name). Unassigned items return `null` and are excluded from the
 * workload chart and its drill-down. An assignee id with no matching member
 * falls back to "Unknown" — matching the aggregation below.
 */
export function assigneeLabel(
  item: AssignedItem,
  memberMap: Map<string, string>,
): string | null {
  if (!item.assigneeId) return null;
  return memberMap.get(item.assigneeId) ?? "Unknown";
}

/**
 * Aggregate items into the top-N assignee workload buckets, highest count
 * first. `limit` mirrors the chart's cap (default 10).
 */
export function workloadBuckets<T extends AssignedItem>(
  items: T[],
  memberMap: Map<string, string>,
  limit = 10,
): Array<{ name: string; items: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = assigneeLabel(item, memberMap);
    if (name === null) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, items: count }))
    .sort((a, b) => b.items - a.items)
    .slice(0, limit);
}
