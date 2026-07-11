"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A page-size choice that survives reloads and sessions, persisted per view in
 * `localStorage` (so it's per user, per browser — no server round-trip, and it
 * never rides into the public image). Mirrors `use-nav-groups.ts`: the stored
 * value is rehydrated AFTER mount, because reading `localStorage` during render
 * would diverge from the server-rendered default and break hydration.
 *
 * @param storageKey namespaced key (e.g. `"cosmos:issues:page-size"`). When
 *                   null/undefined the hook is a plain `useState` with no
 *                   persistence — lets a shared component keep persistence opt-in.
 * @param defaultSize size used on the server and the first client render.
 * @param options    the allowed sizes; a stored value outside this set is
 *                   ignored, so a stale or hand-edited entry can't wedge a view
 *                   onto an unsupported page size.
 * @returns `[pageSize, setPageSize]` — `setPageSize` updates state and writes
 *          through to storage.
 */
export function usePersistentPageSize(
  storageKey: string | null | undefined,
  defaultSize: number,
  options: readonly number[],
): [number, (next: number) => void] {
  const [size, setSize] = useState(defaultSize);
  // Keep the latest options without re-running the rehydration effect on every
  // render — callers routinely pass a fresh array literal. Updated in an effect
  // (never during render) so the rehydration effect can depend only on the key.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw == null) return;
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && optionsRef.current.includes(parsed)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSize(parsed);
      }
    } catch {
      /* storage blocked (private mode / SSR) — keep the default */
    }
  }, [storageKey]);

  const setPageSize = useCallback(
    (next: number) => {
      setSize(next);
      if (!storageKey) return;
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
        /* ignore — the in-memory choice still applies for this session */
      }
    },
    [storageKey],
  );

  return [size, setPageSize];
}
