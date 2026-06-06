export type BusEvent = { topic: string; type: string; data: unknown };
export type BusHandler = (event: BusEvent) => void;

export interface BusAdapter {
  publish(topic: string, type: string, data: unknown): Promise<void>;
  subscribe(topics: string[], handler: BusHandler): () => void;
  close(): Promise<void>;
}

export function createMemoryBus(): BusAdapter {
  const subs = new Map<string, Set<BusHandler>>();

  return {
    async publish(topic, type, data) {
      const set = subs.get(topic);
      if (!set || set.size === 0) return;
      const event: BusEvent = { topic, type, data };
      // Snapshot to avoid mutation-during-iteration if a handler unsubscribes.
      for (const handler of [...set]) {
        try {
          handler(event);
        } catch {
          // Isolate handler failures so one bad subscriber can't block fan-out.
        }
      }
    },

    subscribe(topicList, handler) {
      for (const t of topicList) {
        let set = subs.get(t);
        if (!set) {
          set = new Set();
          subs.set(t, set);
        }
        set.add(handler);
      }
      return () => {
        for (const t of topicList) {
          const set = subs.get(t);
          if (!set) continue;
          set.delete(handler);
          if (set.size === 0) subs.delete(t);
        }
      };
    },

    async close() {
      subs.clear();
    },
  };
}
