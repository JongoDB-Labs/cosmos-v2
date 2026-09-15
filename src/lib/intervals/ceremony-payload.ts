import { isDoneColumnKey } from "./sprint-review";

/**
 * Projections a ceremony board renders. Pure, so the ordering a room looks at
 * is reproducible and testable rather than a property of whatever the query
 * happened to return.
 */

export interface CeremonyItem {
  id: string;
  ticketNumber: number;
  title: string;
  columnKey: string;
  storyPoints?: number | null;
  /** Meeting callout colour; a `WORK_ITEM_HIGHLIGHTS` key or null. */
  highlight?: string | null;
}

export interface CeremonyColumn {
  key: string;
  name: string;
  category?: string;
}

/**
 * What shipped, heaviest first — the order the outbrief reads in, so the room
 * sees the substantial work before the small change.
 *
 * Ties break on ticket number. Without that the order depends on the query plan
 * and the list visibly reshuffles between refetches, which is distracting on a
 * screen a team is staring at. Unestimated items sort last but are NOT dropped:
 * they shipped, and excluding them understates the sprint.
 */
export function shippedItems(items: CeremonyItem[]): CeremonyItem[] {
  return items
    .filter((i) => isDoneColumnKey(i.columnKey))
    .sort(
      (a, b) =>
        (b.storyPoints ?? 0) - (a.storyPoints ?? 0) ||
        a.ticketNumber - b.ticketNumber
    );
}

/**
 * The label for a carried item's status pill, taken from the board's own column
 * so the ceremony speaks the team's vocabulary. A second hardcoded set of status
 * names would be free to disagree with the board it describes.
 */
export function statusLabelFor(
  columnKey: string,
  columns: CeremonyColumn[]
): string {
  return columns.find((c) => c.key === columnKey)?.name ?? columnKey;
}
