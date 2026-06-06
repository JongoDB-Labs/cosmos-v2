import type { BusAdapter } from "./adapter-memory";
import { createMemoryBus } from "./adapter-memory";
import { createPgBus } from "./adapter-pg";

let instance: BusAdapter | null = null;

/**
 * Lazy module-level singleton. Chosen at first call based on env:
 *   REALTIME_BUS=pg       → Postgres LISTEN/NOTIFY (default in production)
 *   REALTIME_BUS=memory   → in-process Map (default in dev/test)
 *
 * The pg adapter requires DATABASE_URL.
 */
export function getBus(): BusAdapter {
  if (instance) return instance;

  const choice =
    process.env.REALTIME_BUS ??
    (process.env.NODE_ENV === "production" ? "pg" : "memory");

  if (choice === "pg") {
    const conn = process.env.DATABASE_URL;
    if (!conn) {
      throw new Error("REALTIME_BUS=pg requires DATABASE_URL");
    }
    instance = createPgBus({
      connectionString: conn,
      onError: (err) => console.warn("[realtime] pg bus error:", err),
    });
  } else if (choice === "memory") {
    instance = createMemoryBus();
  } else {
    throw new Error(`Unknown REALTIME_BUS=${choice} (expected "pg" or "memory")`);
  }

  return instance;
}

/**
 * Test-only escape hatch. Resets the singleton so subsequent getBus() returns
 * a fresh adapter (useful for vitest isolation). Production code should never
 * call this.
 */
export function _resetBusForTests(): void {
  if (instance) {
    void instance.close();
  }
  instance = null;
}

export type { BusAdapter, BusEvent, BusHandler } from "./adapter-memory";
