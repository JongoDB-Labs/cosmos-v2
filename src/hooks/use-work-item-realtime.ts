"use client";

import { useRealtimeEvents } from "./use-realtime-events";

type WorkItemEventPayload = { projectId?: string };

/**
 * Fire `onChange` whenever a work-item create / update / delete event arrives
 * over the org SSE stream (FR: "issue updates without manual refresh"). The
 * work-item routes publishToOrg on every mutation; this subscribes the current
 * view and lets it react (refetch or invalidate its query).
 *
 * Scope to a single project by passing `projectId`; pass `null` (the org-wide
 * Issues view) to react to every project's events. `onChange` is read from a
 * ref inside useRealtimeEvents, so an inline closure always sees fresh state —
 * no need to memoize it at the call site.
 */
export function useWorkItemRealtime(
  orgId: string,
  projectId: string | null,
  onChange: () => void,
) {
  const matches = (data: unknown) => {
    if (!projectId) return true;
    return (data as WorkItemEventPayload)?.projectId === projectId;
  };

  useRealtimeEvents(orgId, {
    "work-item.created": (d) => {
      if (matches(d)) onChange();
    },
    "work-item.updated": (d) => {
      if (matches(d)) onChange();
    },
    "work-item.deleted": (d) => {
      if (matches(d)) onChange();
    },
  });
}
