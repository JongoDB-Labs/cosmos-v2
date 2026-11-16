/**
 * A board's fallback (query design §12.1): the most ids an ids-only query
 * answers with, and the most of its rows a board asks about at once
 * (`among`). Shared, without server code, by the server, which refuses past
 * it, and the board, which doesn't ask past it.
 */
export const IDS_ONLY_MAX = 5_000;

/** What a board says when more of its rows need the server than it checks at once. */
export function amongLimitMessage(count: number): string {
  const n = (x: number) => x.toLocaleString("en-US");
  return `This board needs the server to check ${n(count)} of its items, and it checks at most ${n(IDS_ONLY_MAX)} at a time. Narrow the filter.`;
}
