/**
 * Merging several activity sources into one time-ordered feed.
 *
 * The feed answers "who did what, when" and the events come from places that
 * have nothing in common but a timestamp: a work item changing, an hour being
 * logged, a file arriving. Each source is scoped by its OWN permission rule
 * before it gets here — this module only orders what it is handed, and must
 * never be given events the reader may not see.
 *
 * ## Why the cursor carries an id
 *
 * A cursor of "everything before this instant" silently drops every row that
 * shares the boundary instant. That is a rare accident in a system where
 * events trickle in and a guaranteed one where they arrive in bulk: this
 * practice's 5,396 time entries were imported in a single pass and are dated
 * by the DAY worked, so hundreds of them share a timestamp exactly. Paging
 * such a feed on time alone loses whole days.
 *
 * So the sort key is (at, id) and the cursor carries both. Ties are broken by
 * id — arbitrary but STABLE, which is all a cursor needs.
 */

export type FeedItem = { at: string; id: string };

/** Newest first; ties broken by id, descending, so the order is total. */
export function byNewest(a: FeedItem, b: FeedItem): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export function encodeCursor(item: FeedItem): string {
  return `${item.at}|${item.id}`;
}

/** Null for a missing or malformed cursor — a bad cursor starts at the top. */
export function decodeCursor(cursor: string | null | undefined): FeedItem | null {
  if (!cursor) return null;
  const at = cursor.slice(0, cursor.indexOf("|"));
  const id = cursor.slice(cursor.indexOf("|") + 1);
  if (!at || !id || !cursor.includes("|")) return null;
  return { at, id };
}

/** Whether an item falls strictly before a cursor in (at, id) order. */
export function isBefore(item: FeedItem, cursor: FeedItem | null): boolean {
  if (!cursor) return true;
  if (item.at !== cursor.at) return item.at < cursor.at;
  return item.id < cursor.id;
}

export type Page<T> = { page: T[]; nextCursor: string | null };

/**
 * One page of the merged feed.
 *
 * Each source is expected to have been asked for `limit` items of its own, so
 * the merge always has enough to fill a page from whichever sources happen to
 * be densest. `nextCursor` is the last item returned, and is null only when
 * everything handed in fitted — a source that ran out is not the end of the
 * feed unless every source did.
 */
export function mergePage<T extends FeedItem>(
  sources: T[][],
  limit: number,
  cursor: FeedItem | null = null,
): Page<T> {
  const all = sources
    .flat()
    .filter((i) => isBefore(i, cursor))
    .sort(byNewest);
  const page = all.slice(0, limit);
  const nextCursor =
    all.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;
  return { page, nextCursor };
}
