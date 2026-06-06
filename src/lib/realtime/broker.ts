/**
 * @deprecated Compatibility shim.
 *
 * Delegates to the new typed bus. Existing callers of `publishToOrg` and
 * `subscribeToOrg` keep working unchanged. New code should import `getBus`
 * from `./bus` and use the typed topic builders from `./topics` directly.
 *
 * This file goes away once all callers have been migrated (Phase 2 cleanup).
 */
import { getBus } from "./bus";
import { topics } from "./topics";

export function publishToOrg(orgId: string, type: string, data: unknown): void {
  void getBus().publish(topics.org(orgId), type, data);
}

/**
 * Legacy SSE subscriber shape: receives a pre-formatted `event:` payload string.
 * Wraps the bus subscribe with formatting so existing SSE routes keep working
 * until they migrate to subscribing directly to the bus.
 */
export function subscribeToOrg(
  orgId: string,
  handler: (sse: string) => void,
): () => void {
  return getBus().subscribe([topics.org(orgId)], (event) => {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    try {
      handler(payload);
    } catch {
      /* dead connection — caller will be GC'd */
    }
  });
}

/**
 * Approximate count for legacy callers. The new bus tracks subscribers
 * per-topic; this returns 0 as a non-load-bearing stub.
 */
export function getActiveSubscriberCount(): number {
  return 0;
}
