import { checkRateLimit } from "@/lib/rate-limit/guard";

/**
 * One budget per person for the shared entity search (`searchEntities`),
 * whichever route asks. The ⌘K palette and the @-mention typeahead run the
 * same fan-out over every entity type, so a bucket each would let one route
 * double the other's. The numbers are the Issues search's (work-items/query):
 * a burst of 30, then 3 a second. The palette asks once per 300 ms pause in
 * typing and the typeahead once per 180 ms, so ordinary typing stays inside it.
 *
 * Returns the 429 to send, or null to go on.
 */
export function limitEntitySearch(request: Request, userId: string) {
  return checkRateLimit(request, "entity-search", userId, { capacity: 30, refillPerSecond: 3 });
}
