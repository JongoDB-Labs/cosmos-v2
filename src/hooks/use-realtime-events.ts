"use client";
import { useEffect, useRef } from "react";
import { useBroadcastChannelLeader } from "./use-broadcast-channel-leader";
import { ALL_SERVER_EVENT_TYPES } from "@/lib/realtime/event-types";

type Handlers = Record<string, (data: unknown) => void>;

type RebroadcastMessage = { type: string; data: string };

/** Internal pseudo-event: never published by the server, only by the leader
 *  tab to tell followers that the stream reconnected and they are stale. */
const RESYNC_EVENT = "__cosmos.resync";

/**
 * Subscribes to the org-events SSE stream for the duration of a component's
 * lifetime. To avoid opening multiple EventSources per browser when several
 * Cosmos tabs are open, only the elected leader tab opens the SSE connection;
 * follower tabs receive events via a BroadcastChannel rebroadcast from the
 * leader. Falls back to per-tab SSE if Web Locks aren't available.
 *
 * ## `onResync`, and the events nobody was getting
 *
 * This stream has no replay. The server emits no `id:` field, so the browser's
 * `Last-Event-ID` reconnect header has nothing to ask for and the route ignores
 * it anyway. An event published while a client is not connected is simply gone.
 *
 * `EventSource` reconnects on its own after a drop, so the connection comes
 * back — but the events that happened during the gap never do, and until this
 * existed nothing told the app it had missed anything. The view just sat there
 * showing stale rows, which is indistinguishable from "nothing has changed".
 *
 * The expensive case is a deploy: the app restarts, every open tab's stream
 * drops, and every one of them silently stopped updating until someone pressed
 * refresh. Laptop sleep and any network blip do the same thing on a smaller
 * scale.
 *
 * So `onResync` fires when the stream comes back up, and the caller refetches.
 * It deliberately does NOT fire on the first connect: the query that a view runs
 * on mount already returns current state, and firing here would just duplicate
 * that request on every page load to buy nothing.
 */
export function useRealtimeEvents(
  orgId: string,
  handlers: Handlers,
  options?: { onResync?: () => void },
) {
  const handlersRef = useRef<Handlers>(handlers);
  const onResyncRef = useRef<(() => void) | undefined>(options?.onResync);
  useEffect(() => {
    handlersRef.current = handlers;
    onResyncRef.current = options?.onResync;
  });

  const { isLeader, bcRef } = useBroadcastChannelLeader(`cosmos-events-${orgId}`);

  useEffect(() => {
    const bc = bcRef.current;
    if (!orgId || !bc) return;

    if (isLeader) {
      // Leader tab: open the SSE, dispatch locally, and rebroadcast to followers.
      const es = new EventSource(`/api/v1/orgs/${orgId}/events`);

      // `onopen` fires on the first connect AND on every automatic reconnect.
      // Only the reconnects mean "you were disconnected and missed whatever
      // happened in the gap" — see the note above for why the first is skipped.
      let hasConnected = false;
      es.onopen = () => {
        if (hasConnected) {
          try {
            bc!.postMessage({ type: RESYNC_EVENT, data: "{}" } satisfies RebroadcastMessage);
          } catch {
            /* channel may be closing */
          }
          onResyncRef.current?.();
        }
        hasConnected = true;
      };

      // Rebroadcast ALL named events so follower tabs (which may handle
      // different event types) can receive them. The list lives in
      // lib/realtime/event-types so an arch test can diff it against what the
      // server actually publishes — it drifted, and four events (including
      // ceremony.changed) were never bound on any tab as a result.

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
      // The leader reconnected, so this tab is stale for the same reason it is
      // — it has been reading that one stream all along.
      if (msg.type === RESYNC_EVENT) {
        onResyncRef.current?.();
        return;
      }
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
