type Entry = { connections: number; lastSeen: number };

export type PresenceTransition = "online" | "offline" | null;

/**
 * In-memory presence registry. One per app instance. Tracks how many live SSE
 * connections each user has and their last-seen timestamp (refreshed by the
 * SSE heartbeat ping). `connect`/`disconnect` return a transition string only
 * when the user crosses the online/offline boundary, so callers know exactly
 * when to broadcast a chat.presence.changed event.
 *
 * All times are caller-supplied epoch millis so the logic is deterministic and
 * unit-testable without faking the clock.
 *
 * Multi-instance caveat: this registry only knows about connections on its own
 * instance. Live transitions are broadcast over the bus (see presence wiring in
 * the SSE route) so other instances learn about them, but the initial snapshot
 * served by GET /chat/presence reflects only the answering instance. Correct on
 * single-instance deploys.
 */
export function createPresenceRegistry() {
  const entries = new Map<string, Entry>();

  return {
    connect(userId: string, now: number): PresenceTransition {
      const e = entries.get(userId);
      if (e) {
        e.connections += 1;
        e.lastSeen = now;
        return null;
      }
      entries.set(userId, { connections: 1, lastSeen: now });
      return "online";
    },

    disconnect(userId: string): PresenceTransition {
      const e = entries.get(userId);
      if (!e) return null;
      e.connections -= 1;
      if (e.connections <= 0) {
        entries.delete(userId);
        return "offline";
      }
      return null;
    },

    heartbeat(userId: string, now: number): void {
      const e = entries.get(userId);
      if (e) e.lastSeen = now;
    },

    /** Drop users whose lastSeen is older than `timeoutMs`. Returns dropped ids. */
    sweep(now: number, timeoutMs: number): string[] {
      const dropped: string[] = [];
      for (const [uid, e] of entries) {
        if (now - e.lastSeen > timeoutMs) {
          entries.delete(uid);
          dropped.push(uid);
        }
      }
      return dropped;
    },

    isOnline(userId: string): boolean {
      return entries.has(userId);
    },

    onlineUserIds(): string[] {
      return [...entries.keys()];
    },
  };
}

export type PresenceRegistry = ReturnType<typeof createPresenceRegistry>;

// Module-level singleton for the app instance.
let instance: PresenceRegistry | null = null;
export function getPresence(): PresenceRegistry {
  if (!instance) instance = createPresenceRegistry();
  return instance;
}
