"use client";
import { useEffect, useReducer } from "react";
import { useRealtimeEvents } from "./use-realtime-events";
import type { ChatMessageDto } from "./use-chat-messages";

export type PinnedDto = {
  pinnedById: string;
  pinnedAt: string;
  message: ChatMessageDto;
};

type State = { pins: PinnedDto[]; pinnedIds: Set<string> };
type Action =
  | { type: "seed"; pins: PinnedDto[] }
  | { type: "remove"; messageId: string }
  | { type: "reset" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "seed":
      return { pins: action.pins, pinnedIds: new Set(action.pins.map((p) => p.message.id)) };
    case "remove": {
      if (!state.pinnedIds.has(action.messageId)) return state;
      const pins = state.pins.filter((p) => p.message.id !== action.messageId);
      return { pins, pinnedIds: new Set(pins.map((p) => p.message.id)) };
    }
    case "reset":
      return { pins: [], pinnedIds: new Set() };
  }
}

export function usePinnedMessages(orgId: string, channelId: string) {
  const [state, dispatch] = useReducer(reducer, { pins: [], pinnedIds: new Set<string>() });

  // Seed (and re-seed) from the list endpoint.
  useEffect(() => {
    if (!orgId || !channelId) return;
    let cancelled = false;
    dispatch({ type: "reset" });
    const load = () =>
      fetch(`/api/v1/orgs/${orgId}/chat/channels/${channelId}/pins`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j && !cancelled) dispatch({ type: "seed", pins: j.pins ?? [] }); })
        .catch(() => {});
    void load();
    return () => { cancelled = true; };
  }, [orgId, channelId]);

  useRealtimeEvents(orgId, {
    "chat.pin.added": (data: unknown) => {
      const d = data as { channelId: string };
      if (d.channelId !== channelId) return;
      // The event lacks the full message DTO; re-seed from the list endpoint.
      fetch(`/api/v1/orgs/${orgId}/chat/channels/${channelId}/pins`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j) dispatch({ type: "seed", pins: j.pins ?? [] }); })
        .catch(() => {});
    },
    "chat.pin.removed": (data: unknown) => {
      const d = data as { channelId: string; messageId: string };
      if (d.channelId !== channelId) return;
      dispatch({ type: "remove", messageId: d.messageId });
    },
  });

  return { pins: state.pins, pinnedIds: state.pinnedIds };
}
