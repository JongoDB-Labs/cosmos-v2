/**
 * Does an outbox event fire a rule's trigger? Pure: decided from the event
 * alone (its type and payload, plus the categories of the statuses a
 * transition left and entered, read when the event is processed).
 * Scheduled triggers never match an event; the schedule job runs them.
 */
import type { AutomationTrigger } from "./spec";

export interface TriggerEvent {
  type: string;
  /** The outbox payload: `{ from, to, changes }` for a transition, `{ changes }` for an update. */
  payload: { from?: unknown; to?: unknown; changes?: Record<string, unknown> };
  fromCategory?: string | null;
  toCategory?: string | null;
}

export function triggerMatches(trigger: AutomationTrigger, e: TriggerEvent): boolean {
  switch (trigger.on) {
    case "item.created":
      return e.type === "work_item.created";
    case "item.updated": {
      if (e.type !== "work_item.updated") return false;
      if (!trigger.fields) return true;
      const changed = Object.keys(e.payload.changes ?? {});
      return trigger.fields.some((f) => changed.includes(f));
    }
    case "item.transitioned": {
      if (e.type !== "work_item.transitioned") return false;
      if (trigger.from && !trigger.from.includes(String(e.payload.from))) return false;
      if (trigger.to && !trigger.to.includes(String(e.payload.to))) return false;
      if (trigger.toCategory && !(e.toCategory && (trigger.toCategory as readonly string[]).includes(e.toCategory))) return false;
      return true;
    }
    case "schedule":
      return false;
  }
}

/** Is a scheduled trigger due at `now`, given when it last ran? Due at most once per slot. */
export function scheduleDue(trigger: Extract<AutomationTrigger, { on: "schedule" }>, now: Date, lastRunAt: Date | null): boolean {
  const slot = new Date(now);
  slot.setUTCSeconds(0, 0);
  slot.setUTCMinutes(trigger.minute);
  if (trigger.every !== "hour") slot.setUTCHours(trigger.hour);
  if (trigger.every === "week") slot.setUTCDate(slot.getUTCDate() - ((slot.getUTCDay() + 6) % 7)); // back to Monday
  // The most recent slot at or before now.
  const period = trigger.every === "hour" ? 3_600_000 : trigger.every === "day" ? 86_400_000 : 7 * 86_400_000;
  while (slot.getTime() > now.getTime()) slot.setTime(slot.getTime() - period);
  return !lastRunAt || lastRunAt.getTime() < slot.getTime();
}
