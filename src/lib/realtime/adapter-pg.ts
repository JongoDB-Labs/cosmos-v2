import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { createMemoryBus, type BusAdapter } from "./adapter-memory";

const CHANNEL = "cosmos_events";
const MAX_PAYLOAD_BYTES = 6000; // Postgres NOTIFY limit is 8 KB; leave headroom

export interface PgBusOptions {
  connectionString: string;
  onError?: (err: unknown) => void;
}

type NotifyPayload = {
  instanceId: string;
  topic: string;
  type: string;
  data: unknown;
};

/**
 * Postgres LISTEN/NOTIFY-backed BusAdapter.
 *
 * Architecture: one persistent `pg` client per app instance LISTENs to a single
 * Postgres channel. Incoming NOTIFY payloads are re-published through a local
 * in-memory bus, which handles per-connection subscriber routing. Outgoing
 * `publish()` calls also fire the local bus immediately (so the publisher sees
 * its own event even if the LISTEN connection is briefly down), then send
 * NOTIFY for cross-instance fan-out. Each adapter instance tags its NOTIFY
 * payloads with a per-instance UUID; the LISTEN handler skips local re-fan-out
 * when it sees its own id (because local fan-out already happened in publish()).
 *
 * Connection failure: adapter retries with exponential backoff up to 30 s.
 * Local fan-out continues working during the outage; only cross-instance
 * delivery is degraded.
 *
 * Payload size: when the JSON payload exceeds MAX_PAYLOAD_BYTES, NOTIFY sends
 * a ref-only marker `{ __overflow: true }` so receivers know to refetch via
 * HTTP. Phase 1 uses this only as a defensive ceiling; chat message previews
 * stay well under the limit.
 */
export function createPgBus(opts: PgBusOptions): BusAdapter {
  const local = createMemoryBus();
  const instanceId = randomUUID();
  let client: Client | null = null;
  let connected = false;
  let closing = false;
  let retryMs = 1000;

  async function connect(): Promise<void> {
    if (closing) return;
    try {
      const c = new Client({ connectionString: opts.connectionString });
      await c.connect();
      if (closing) {
        await c.end().catch(() => {});
        return;
      }
      await c.query(`LISTEN ${CHANNEL}`);
      if (closing) {
        await c.end().catch(() => {});
        return;
      }
      c.on("notification", (msg) => {
        if (!msg.payload) return;
        try {
          const parsed = JSON.parse(msg.payload) as NotifyPayload;
          // Skip our own NOTIFY round-trip — local fan-out already happened in publish().
          if (parsed.instanceId === instanceId) return;
          void local.publish(parsed.topic, parsed.type, parsed.data);
        } catch (e) {
          opts.onError?.(e);
        }
      });
      c.on("error", (err) => {
        opts.onError?.(err);
        connected = false;
        client = null;
        if (!closing) {
          retryMs = Math.min(retryMs * 2, 30_000);
          setTimeout(() => void connect(), retryMs);
        }
      });
      client = c;
      connected = true;
      retryMs = 1000;
    } catch (err) {
      opts.onError?.(err);
      connected = false;
      client = null;
      if (!closing) {
        retryMs = Math.min(retryMs * 2, 30_000);
        setTimeout(() => void connect(), retryMs);
      }
    }
  }

  void connect();

  return {
    async publish(topic, type, data) {
      // Local fan-out is unconditional so the publisher sees its own event
      // even if the pg LISTEN connection is briefly down.
      await local.publish(topic, type, data);

      if (!connected || !client) return; // cross-instance delivery degraded during outage
      let payload = JSON.stringify({ instanceId, topic, type, data } satisfies NotifyPayload);
      if (payload.length > MAX_PAYLOAD_BYTES) {
        // Downgrade to a ref-only event so receivers can refetch via HTTP.
        payload = JSON.stringify({ instanceId, topic, type, data: { __overflow: true } } satisfies NotifyPayload);
      }
      try {
        await client.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
      } catch (err) {
        opts.onError?.(err);
      }
    },

    subscribe(topicList, handler) {
      return local.subscribe(topicList, handler);
    },

    async close() {
      closing = true;
      await local.close();
      if (client) {
        try {
          await client.end();
        } catch {
          /* ignore */
        }
        client = null;
        connected = false;
      }
    },
  };
}
