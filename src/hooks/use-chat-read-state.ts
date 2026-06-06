"use client";
import { useCallback, useEffect, useReducer } from "react";

type State = Map<string, string>; // userId -> lastReadMessageId

type Action =
  | { type: "seed"; entries: [string, string][] }
  | { type: "receipt"; userId: string; lastReadMessageId: string }
  | { type: "reset" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "seed": {
      return new Map(action.entries);
    }
    case "receipt": {
      const next = new Map(state);
      next.set(action.userId, action.lastReadMessageId);
      return next;
    }
    case "reset":
      return new Map();
  }
}

/**
 * Maps userId -> lastReadMessageId for the OTHER members of a channel.
 * Seeds from GET /read-state; applies chat.read.receipt deltas.
 */
export function useChatReadState(orgId: string, channelId: string) {
  const [state, dispatch] = useReducer(reducer, undefined, () => new Map<string, string>());

  useEffect(() => {
    if (!orgId || !channelId) return;
    let cancelled = false;
    dispatch({ type: "reset" });
    (async () => {
      try {
        const r = await fetch(
          `/api/v1/orgs/${orgId}/chat/channels/${channelId}/read-state`,
        );
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled) return;
        const entries: [string, string][] = [];
        for (const row of j.readState ?? []) {
          if (row.lastReadMessageId) entries.push([row.userId, row.lastReadMessageId]);
        }
        dispatch({ type: "seed", entries });
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, channelId]);

  const applyReceipt = useCallback((userId: string, lastReadMessageId: string) => {
    dispatch({ type: "receipt", userId, lastReadMessageId });
  }, []);

  return { readState: state, applyReceipt };
}
