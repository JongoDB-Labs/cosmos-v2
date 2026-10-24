/**
 * The webhook events a subscriber can pick, and which outbox events
 * (`domain_events`, src/lib/work-items/events.server.ts) deliver each.
 * Client-safe: the webhook settings picker lists WEBHOOK_EVENTS.
 *
 * A webhook stores the names it subscribes to as strings, so a name is never
 * renamed here: one that stops being sent is dropped from this list, and a
 * subscription that still names it simply receives nothing for it.
 */
export const WEBHOOK_EVENTS = [
  { name: "work_item.created", label: "An item is created" },
  { name: "work_item.updated", label: "An item's fields change (not its status)" },
  { name: "work_item.transitioned", label: "An item moves to another status" },
  { name: "work_item.completed", label: "An item moves to a Done status" },
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number]["name"];

/** What the mapping needs to know about one outbox event. */
export interface OutboxEventFacts {
  type: string;
  /** For a transition: the category of the status the item moved to, read when the event is processed. */
  toCategory?: string | null;
  /** For a transition: the category of the status it left. */
  fromCategory?: string | null;
}

/** The webhook event names one outbox event is delivered under. */
export function webhookEventsFor(e: OutboxEventFacts): WebhookEventName[] {
  switch (e.type) {
    case "work_item.created":
      return ["work_item.created"];
    case "work_item.updated":
      return ["work_item.updated"];
    case "work_item.transitioned":
      // Completed only on the way INTO Done: Done to another Done status isn't news.
      return e.toCategory === "DONE" && e.fromCategory !== "DONE" ? ["work_item.transitioned", "work_item.completed"] : ["work_item.transitioned"];
    default:
      return [];
  }
}
