"use client";
import { useReducer } from "react";
import { useRealtimeEvents } from "./use-realtime-events";

type Action =
  | { type: "bump"; channelId: string }
  | { type: "clear"; channelId: string }
  | { type: "reset" };

function reducer(state: Set<string>, action: Action): Set<string> {
  switch (action.type) {
    case "bump": {
      if (state.has(action.channelId)) return state;
      const next = new Set(state);
      next.add(action.channelId);
      return next;
    }
    case "clear": {
      if (!state.has(action.channelId)) return state;
      const next = new Set(state);
      next.delete(action.channelId);
      return next;
    }
    case "reset":
      return new Set();
  }
}

/**
 * Count of channels with unseen activity. Increments on chat.unread.bumped,
 * clears a channel on chat.read.updated (the user's own read marker, fired
 * across their tabs). A "channels with unread" count, not a message count —
 * sufficient for the mobile nav badge.
 */
export function useTotalUnread(orgId: string): number {
  const [unread, dispatch] = useReducer(reducer, new Set<string>());

  useRealtimeEvents(orgId, {
    "chat.unread.bumped": (data: unknown) => {
      const d = data as { channelId: string };
      dispatch({ type: "bump", channelId: d.channelId });
    },
    "chat.read.updated": (data: unknown) => {
      const d = data as { channelId: string };
      dispatch({ type: "clear", channelId: d.channelId });
    },
  });

  return unread.size;
}
