"use client";
import { useEffect, useState } from "react";
import { useRealtimeEvents } from "./use-realtime-events";

/**
 * Live set of online user ids. Seeds from GET /chat/presence, then applies
 * chat.presence.changed deltas from the SSE stream.
 */
export function useChatPresence(orgId: string) {
  const [online, setOnline] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/v1/orgs/${orgId}/chat/presence`);
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setOnline(new Set<string>(j.online ?? []));
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  useRealtimeEvents(orgId, {
    "chat.presence.changed": (data: unknown) => {
      const d = data as { userId: string; status: "online" | "offline" };
      setOnline((prev) => {
        const next = new Set(prev);
        if (d.status === "online") next.add(d.userId);
        else next.delete(d.userId);
        return next;
      });
    },
  });

  return online;
}
