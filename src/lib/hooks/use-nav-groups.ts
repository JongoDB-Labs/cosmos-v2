"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "cosmos:nav-groups-expanded";

/**
 * Persist which sidebar parent groups are expanded, per user (localStorage).
 * Defaults to all groups collapsed; if a group is active we expand it on first
 * mount (handled by the caller seeding `defaultExpanded`).
 */
export function useNavGroups(defaultExpanded: string[] = []) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(defaultExpanded),
  );

  // Read persisted state after mount (reading localStorage during render would
  // cause a hydration mismatch — the server has no storage). This setState-in-
  // effect is the documented localStorage-rehydration exception used across
  // the codebase (see assistant-panel.tsx).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const ids = JSON.parse(raw) as string[];
        if (Array.isArray(ids)) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setExpanded(new Set([...ids, ...defaultExpanded]));
        }
      }
    } catch {
      /* ignore */
    }
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([...next]),
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const isExpanded = useCallback((id: string) => expanded.has(id), [expanded]);

  return { isExpanded, toggle };
}
