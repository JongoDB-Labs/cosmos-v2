// Pure vocabulary + math for Foreman observability, shared by the daemon
// writer (scripts/foreman/observe.mts), the status API, and the UI. No I/O.

export const EVENT_KINDS = [
  "boot", "claimed", "duplicate", "needs-input", "gated", "already-done",
  "repair", "queued-ship", "shipped", "parked", "ship-failed",
  "merged-undeployed", "requeued", "mention-reply", "reclaimed", "breaker",
  "resync", "error",
] as const;
export type ForemanEventKind = (typeof EVENT_KINDS)[number];

/** Event kinds that mean "this ticket is parked in review awaiting a human
 *  decision" — the ONE union read by BOTH the console's approval panel
 *  (src/lib/foreman/status-read.ts) and the daemon's mention/approve ingestion
 *  (scripts/foreman/db.mts freshMentions), so the console can never show an
 *  Approve the daemon can't hear. All five are meaningful to approve:
 *  parked/gated (the checks/risk/reviewer gate) carry a draft PR; ship-failed
 *  (PR exists → approve retries the merge) and merged-undeployed (approve →
 *  already-merged reply, reconcile owns the deploy) carry a PR too; needs-input
 *  has no PR, so an approve there gets the nothing-built reply. */
export const PARKED_EVENT_KINDS = [
  "parked", "gated", "needs-input", "ship-failed", "merged-undeployed",
] as const;

/** A build a worker slot is holding right now, as stored in foreman_state.inFlight. */
export type InFlightBuild = {
  key: string;
  itemId: string;
  orgId: string;
  title: string;
  phase: "building" | "checks" | "repair" | "review" | "queued-ship" | "shipping";
  since: string; // ISO
  repairRound?: number;
};

export type Pulse = "alive" | "idle" | "stale" | "paused" | "breaker";

export const ALIVE_MS = 2 * 60_000;
export const STALE_MS = 10 * 60_000;

/** Pulse precedence: paused > breaker/stop > staleness. `null` lastPassAt is
 *  stale — a daemon that never heartbeat is indistinguishable from a dead one. */
export function pulseFor(i: {
  lastPassAt: Date | string | null;
  paused: boolean;
  breakerTripped: boolean;
  stopFileSeen: boolean;
  now?: Date;
}): Pulse {
  if (i.paused) return "paused";
  if (i.breakerTripped || i.stopFileSeen) return "breaker";
  if (!i.lastPassAt) return "stale";
  const t = typeof i.lastPassAt === "string" ? new Date(i.lastPassAt) : i.lastPassAt;
  const age = (i.now ?? new Date()).getTime() - t.getTime();
  if (age < ALIVE_MS) return "alive";
  if (age < STALE_MS) return "idle";
  return "stale";
}

/** Ledger Resolution -> event kind, for the one-time jsonl backfill. */
export const LEDGER_KIND_MAP: Record<string, ForemanEventKind> = {
  shipped: "shipped",
  gated: "gated",
  duplicate: "duplicate",
  "already-done": "already-done",
  "needs-input": "needs-input",
};
