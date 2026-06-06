"use client";
import { useCallback, useEffect, useReducer, useRef } from "react";

type TypingEvent = { userId: string; channelId: string; expiresAt: number };

type State = Map<string, number>; // userId -> expiresAt

type Action =
  | { type: "feed"; userId: string; expiresAt: number }
  | { type: "prune"; now: number }
  | { type: "reset" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "feed": {
      const next = new Map(state);
      next.set(action.userId, action.expiresAt);
      return next;
    }
    case "prune": {
      let changed = false;
      const next = new Map(state);
      for (const [uid, exp] of state) {
        if (exp <= action.now) {
          next.delete(uid);
          changed = true;
        }
      }
      return changed ? next : state;
    }
    case "reset":
      return new Map();
  }
}

/**
 * Tracks who is currently typing in a channel. Call `feedTypingEvent` from the
 * SSE `chat.typing` handler; `typingUserIds` is the live set (excluding the
 * current user), pruned when each entry's expiresAt passes. `emitTyping`
 * returns a throttled POST trigger for the composer to call on keystroke.
 */
export function useChatTyping(
  orgId: string,
  channelId: string,
  currentUserId: string,
) {
  const [typing, dispatch] = useReducer(reducer, undefined, () => new Map<string, number>());
  const lastEmitRef = useRef(0);

  const feedTypingEvent = useCallback(
    (ev: TypingEvent) => {
      if (ev.channelId !== channelId) return;
      if (ev.userId === currentUserId) return;
      dispatch({ type: "feed", userId: ev.userId, expiresAt: ev.expiresAt });
    },
    [channelId, currentUserId],
  );

  // Prune expired entries once a second.
  useEffect(() => {
    const t = setInterval(() => {
      dispatch({ type: "prune", now: Date.now() });
    }, 1_000);
    return () => clearInterval(t);
  }, []);

  // Reset when switching channels.
  useEffect(() => {
    dispatch({ type: "reset" });
  }, [channelId]);

  const emitTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastEmitRef.current < 3_000) return; // throttle: at most once per 3s
    lastEmitRef.current = now;
    fetch(`/api/v1/orgs/${orgId}/chat/channels/${channelId}/typing`, {
      method: "POST",
    }).catch(() => {
      /* best-effort */
    });
  }, [orgId, channelId]);

  return { typingUserIds: [...typing.keys()], feedTypingEvent, emitTyping };
}
