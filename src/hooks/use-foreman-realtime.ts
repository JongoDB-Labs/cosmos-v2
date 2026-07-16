"use client";

import { useRealtimeEvents } from "./use-realtime-events";

/**
 * The org-scoped events the Foreman console reacts to. Work-item.* covers every
 * board state change the daemon drives (COSMOS-107 publishes on db.moveColumn),
 * so an Approve/Rework/Rebuild that lands the ticket in its next column reflects
 * in the console's Awaiting-Approval / In-Flight lists the instant the move
 * publishes — no waiting on the status poll. Feedback.* covers intake decisions
 * surfaced on the console (throttled/gated/flagged/duplicate/delivered).
 */
const FOREMAN_EVENT_TYPES = [
  "work-item.created",
  "work-item.updated",
  "work-item.deleted",
  "feedback.throttled",
  "feedback.gated",
  "feedback.flagged",
  "feedback.duplicate",
  "feedback.delivered",
] as const;

/**
 * Subscribe the Foreman console to the org realtime stream (COSMOS-127). Fires
 * `onChange` whenever a work-item or feedback event arrives so the console can
 * refetch its status / event feed / intake decisions live, letting it lean on a
 * slow reconnect-backstop poll rather than a fast 15s one.
 *
 * `onChange` is read from a ref inside useRealtimeEvents, so an inline closure at
 * the call site always sees fresh state — no need to memoize it.
 */
export function useForemanRealtime(orgId: string, onChange: () => void) {
  const handlers: Record<string, (data: unknown) => void> = {};
  for (const type of FOREMAN_EVENT_TYPES) {
    handlers[type] = () => onChange();
  }
  useRealtimeEvents(orgId, handlers);
}
