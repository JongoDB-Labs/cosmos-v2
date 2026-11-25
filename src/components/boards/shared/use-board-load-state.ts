"use client";

/**
 * React Query side of board-load-state.ts: per critical query, whether its
 * last NETWORK fetch failed, and whether an access error is latched.
 *
 * `error` alone can't say that. React Query keeps the old data when a refetch
 * fails (good) but also sets `error`; and `setQueryData` (an optimistic update
 * or its rollback) clears `error` without fetching anything. So this listens to
 * the query cache: a fetch that ends in error sets the flag, a fetch that ends
 * in success clears it, and a manual cache write leaves it alone.
 *
 * Memory is kept per query hash, so a view whose key changes in place (the
 * ceremony board's sprint and team pickers) never carries one key's failure
 * over to another. A view that mounts onto a key already holding error-with-data
 * starts as "refresh failed".
 */
import { useEffect, useState } from "react";
import {
  hashKey,
  isCancelledError,
  useQueryClient,
  type QueryKey,
  type QueryState,
} from "@tanstack/react-query";
import {
  FRESH_READ,
  classifyBoardLoad,
  isAccessError,
  recordFetch,
  type BoardLoadVerdict,
  type ReadMemory,
} from "./board-load-state";

export interface BoardRead {
  queryKey: QueryKey;
  query: {
    data: unknown;
    error: unknown;
    fetchStatus: string;
    refetch: () => Promise<unknown>;
  };
  /** A 404 on this read means hidden or gone (board detail, items, ceremony payload). */
  notFoundIsAccess?: boolean;
}

export interface BoardLoadState extends BoardLoadVerdict {
  /** A critical read is fetching right now (show the skeleton over a fatal error while retrying). */
  fetching: boolean;
  /** Refetch the critical reads that are in error. */
  retry: () => void;
  /** Changes whenever the reads' keys change; hand it to useRefreshFailedNotice. */
  noticeKey: string;
}

function memoryFromState(
  state: { status: QueryState["status"]; data: unknown; error: unknown },
  notFoundIsAccess?: boolean,
): ReadMemory {
  return {
    lastFetchFailed: state.status === "error" && state.data !== undefined,
    accessLatched: state.status === "error" && isAccessError(state.error, notFoundIsAccess),
  };
}

export function useBoardLoadState(reads: readonly BoardRead[]): BoardLoadState {
  const qc = useQueryClient();
  const hashes = reads.map((r) => hashKey(r.queryKey));
  const hashList = hashes.join("|");
  const [memory, setMemory] = useState<Record<string, ReadMemory>>({});

  // Which hashes we watch, and how each treats a 404. A string dep keeps the
  // subscription stable across renders (useOrgQueryKey builds a fresh array each render).
  const access404 = reads.map((r) => (r.notFoundIsAccess ? "1" : "0")).join("");
  useEffect(() => {
    const watched = new Map<string, boolean>();
    hashList.split("|").forEach((h, i) => watched.set(h, access404[i] === "1"));
    // Snapshot the cache before listening: a view that remounts onto a query
    // still holding a 403 must keep that latch when the next fetch fails differently.
    const seeds = new Map<string, ReadMemory>();
    watched.forEach((notFoundIsAccess, h) => {
      const state = qc.getQueryCache().get(h)?.state;
      if (state?.status === "error") seeds.set(h, memoryFromState(state, notFoundIsAccess));
    });
    return qc.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const hash = event.query.queryHash;
      if (!watched.has(hash)) return;
      const action = event.action;
      const notFoundIsAccess = watched.get(hash);
      if (action.type === "error") {
        if (isCancelledError(action.error)) return;
        setMemory((prev) => ({
          ...prev,
          [hash]: recordFetch(prev[hash] ?? seeds.get(hash) ?? FRESH_READ, {
            ok: false,
            error: action.error,
            notFoundIsAccess,
          }),
        }));
      } else if (action.type === "success" && !action.manual) {
        setMemory((prev) => (prev[hash] ? { ...prev, [hash]: FRESH_READ } : prev));
      }
    });
  }, [qc, hashList, access404]);

  const states = reads.map((r, i) => {
    const m =
      memory[hashes[i]] ??
      memoryFromState(
        { status: r.query.error ? "error" : "success", data: r.query.data, error: r.query.error },
        r.notFoundIsAccess,
      );
    return {
      error: r.query.error,
      hasData: r.query.data !== undefined,
      lastFetchFailed: m.lastFetchFailed,
      accessLatched: m.accessLatched,
      notFoundIsAccess: r.notFoundIsAccess,
    };
  });
  const verdict = classifyBoardLoad(states);

  return {
    ...verdict,
    fetching: reads.some((r) => r.query.fetchStatus === "fetching"),
    retry: () => {
      reads.forEach((r, i) => {
        if (r.query.error || states[i].lastFetchFailed || states[i].accessLatched) {
          void r.query.refetch();
        }
      });
    },
    noticeKey: hashList,
  };
}
