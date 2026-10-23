/**
 * Deep link to one feedback item: the board, opened on that item's detail.
 * PURE, so server notifications and the client build the same URL. Every
 * feedback notification used to point at the bare board, leaving the reader
 * to find their item among the rest.
 */
export function feedbackItemUrl(orgSlug: string, itemId: string): string {
  return `/${orgSlug}/feedback?item=${encodeURIComponent(itemId)}`;
}
