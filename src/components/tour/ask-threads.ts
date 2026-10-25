"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AskTurn = { question: string; answer: string; error?: string };
export type AskThread = { conversationId: string | null; turns: AskTurn[] };

export const EMPTY_THREAD: AskThread = { conversationId: null, turns: [] };

/**
 * The walkthrough's questions, one temporary conversation per step.
 *
 * Each step gets its own assistant conversation, created on the first question
 * and reused for follow-ups, so the model sees what was already asked (the
 * messages route sends the conversation's history). The thread lives here, in
 * memory, rather than in the Ask panel, so going Back to a step shows what was
 * asked there.
 *
 * Temporary on purpose. The conversation is deleted when the reader starts a
 * new one, when the card closes, and when the page goes away. The walkthrough
 * is not where somebody keeps a record, and before this every question left
 * its own conversation behind in their assistant history. Deletion is
 * best-effort: the endpoint only ever deletes the caller's own, so a failure
 * leaves nothing anybody else can see.
 */
export function useAskThreads(orgId: string) {
  const [threads, setThreads] = useState<Record<string, AskThread>>({});
  // Mirrors the conversation ids for the page-hide and close paths, which
  // run outside a render and must not read stale state.
  const ids = useRef(new Set<string>());

  const discard = useCallback(
    (conversationId: string | null) => {
      if (!conversationId) return;
      ids.current.delete(conversationId);
      void fetch(`/api/v1/orgs/${orgId}/assistant/conversations/${conversationId}`, {
        method: "DELETE",
        // Survives the page unloading, which is one of the moments this runs.
        keepalive: true,
      }).catch(() => undefined);
    },
    [orgId],
  );

  const update = useCallback((key: string, fn: (t: AskThread) => AskThread) => {
    setThreads((all) => {
      const next = fn(all[key] ?? EMPTY_THREAD);
      if (next.conversationId) ids.current.add(next.conversationId);
      return { ...all, [key]: next };
    });
  }, []);

  /** A new conversation for this step: the old one is deleted, the thread emptied. */
  const reset = useCallback(
    (key: string, conversationId: string | null) => {
      discard(conversationId);
      setThreads((all) => {
        const rest = { ...all };
        delete rest[key];
        return rest;
      });
    },
    [discard],
  );

  // The card closed (the owner unmounts with it) or the tab is going away:
  // nothing asked in the walkthrough should outlive it.
  useEffect(() => {
    const live = ids.current;
    const discardAll = () => {
      for (const id of [...live]) discard(id);
    };
    window.addEventListener("pagehide", discardAll);
    return () => {
      window.removeEventListener("pagehide", discardAll);
      discardAll();
    };
  }, [discard]);

  return { threads, update, reset };
}
