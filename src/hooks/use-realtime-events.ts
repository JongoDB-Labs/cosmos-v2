"use client";
import { useEffect, useRef } from "react";
import { useBroadcastChannelLeader } from "./use-broadcast-channel-leader";

type Handlers = Record<string, (data: unknown) => void>;

type RebroadcastMessage = { type: string; data: string };

/**
 * Subscribes to the org-events SSE stream for the duration of a component's
 * lifetime. To avoid opening multiple EventSources per browser when several
 * Cosmos tabs are open, only the elected leader tab opens the SSE connection;
 * follower tabs receive events via a BroadcastChannel rebroadcast from the
 * leader. Falls back to per-tab SSE if Web Locks aren't available.
 */
export function useRealtimeEvents(orgId: string, handlers: Handlers) {
  const handlersRef = useRef<Handlers>(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const { isLeader, bcRef } = useBroadcastChannelLeader(`cosmos-events-${orgId}`);

  useEffect(() => {
    const bc = bcRef.current;
    if (!orgId || !bc) return;

    if (isLeader) {
      // Leader tab: open the SSE, dispatch locally, and rebroadcast to followers.
      const es = new EventSource(`/api/v1/orgs/${orgId}/events`);

      // Rebroadcast ALL named events so follower tabs (which may handle
      // different event types) can receive them. We listen on the raw
      // EventSource 'message' fallback for unnamed events and on a typed
      // listener for every known server-side event type. The server only
      // sends named events (event: <type>), so the typed listeners are the
      // effective path; the message fallback handles any future unnamed events.
      const ALL_SERVER_EVENT_TYPES = [
        "chat.message.created",
        "chat.message.updated",
        "chat.message.deleted",
        "chat.message.streaming",
        "chat.reaction.added",
        "chat.reaction.removed",
        "chat.typing",
        "chat.presence.changed",
        "chat.read.receipt",
        "chat.unread.bumped",
        "chat.read.updated",
        "chat.pin.added",
        "chat.pin.removed",
        "chat.channel.joined",
        "chat.channel.left",
        "notification.created",
        "work-item.created",
        "work-item.updated",
        "work-item.deleted",
        "hello",
      ] as const;

      const bound: Array<[string, EventListener]> = [];

      function makeHandler(type: string): EventListener {
        return (ev: Event) => {
          const raw = (ev as MessageEvent).data;
          // Rebroadcast to all follower tabs regardless of whether the leader
          // itself handles this type.
          try {
            bc!.postMessage({ type, data: raw } satisfies RebroadcastMessage);
          } catch {
            /* channel may be closing */
          }
          // Also dispatch locally if the leader has a handler for this type.
          const h = handlersRef.current[type];
          if (!h) return;
          try {
            h(JSON.parse(raw));
          } catch {
            /* malformed */
          }
        };
      }

      for (const type of ALL_SERVER_EVENT_TYPES) {
        const fn = makeHandler(type);
        es.addEventListener(type, fn);
        bound.push([type, fn]);
      }

      // Also handle types registered by the leader that aren't in the static
      // list above, so locally-registered handlers still fire.
      for (const type of Object.keys(handlersRef.current)) {
        if (!ALL_SERVER_EVENT_TYPES.includes(type as (typeof ALL_SERVER_EVENT_TYPES)[number])) {
          const fn = makeHandler(type);
          es.addEventListener(type, fn);
          bound.push([type, fn]);
        }
      }

      return () => {
        for (const [t, fn] of bound) es.removeEventListener(t, fn);
        es.close();
      };
    }

    // Follower tab: just listen for the rebroadcast.
    function onMessage(ev: MessageEvent) {
      const msg = ev.data as RebroadcastMessage | undefined;
      if (!msg || typeof msg.type !== "string") return;
      const h = handlersRef.current[msg.type];
      if (!h) return;
      try {
        h(JSON.parse(msg.data));
      } catch {
        /* malformed */
      }
    }
    bc.addEventListener("message", onMessage);
    return () => bc.removeEventListener("message", onMessage);
  }, [orgId, isLeader, bcRef]);
}
